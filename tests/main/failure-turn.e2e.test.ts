import { describe, expect, it } from "vitest";
import type { FailureCause } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import {
  ask,
  failedTask,
  failTask,
  historyOf,
  lastTurn,
  newResult,
  offerLine,
  retryRoute,
  turnOf,
} from "./failure.harness";
import {
  askRoute,
  decision,
  replyRoute,
  stopRoute,
  workRoute,
} from "./tasks/harness";
import { admitAs, failFront, streamFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const errorCause =
  "Something went wrong while I was working on that. Try me again in a bit.";

const noRetry = "Don't offer to try again.";

const keySteps = `Say one of your keys isn't working, and that they should check the env file and restart you. ${noRetry}`;
const creditSteps = `Say one of your accounts has run out of credit, and that you can't help until it's topped up. ${noRetry}`;

const steadyRows: { kind: FailureCause; step: string }[] = [
  {
    kind: "nothingFound",
    step: `Say you couldn't find it and ask for a detail or a different angle. ${noRetry}`,
  },
  {
    kind: "modelsUnreachable",
    step: `Say you're having trouble right now and suggest a few minutes later. ${noRetry}`,
  },
  {
    kind: "searchDown",
    step: `Say you can't look it up right now and suggest asking again in a few minutes. ${noRetry}`,
  },
  { kind: "keyRejected", step: keySteps },
  { kind: "searchKeyRejected", step: keySteps },
  { kind: "noCredit", step: creditSteps },
  { kind: "searchQuota", step: creditSteps },
  {
    kind: "limitHit",
    step: `Say it's a bit big for you and ask them to ask about one part of it. ${noRetry}`,
  },
];

// What admitAs(w, "hermes") leaves in Chat.
const started = ["tell me hermes", "Checking hermes."];

const nextStepRows: {
  kind: FailureCause;
  retried: boolean;
  step: string;
  offers: boolean;
}[] = [
  ...steadyRows.flatMap((row) => [
    { ...row, retried: false, offers: false },
    { ...row, retried: true, offers: false },
  ]),
  {
    kind: "error",
    retried: false,
    step: "Say something went wrong while you were working on it and ask if you should try once more.",
    offers: true,
  },
  {
    kind: "error",
    retried: true,
    step: `Say you couldn't get it done and make one short ask that fits the request. ${noRetry}`,
    offers: false,
  },
];

describe("what a failure turn is told to offer", () => {
  it.each(nextStepRows)(
    "$kind, retried $retried: next step, offer $offers",
    async ({ kind, retried, step, offers }) => {
      const w = wire();
      await admitAs(w, "hermes");
      await w.playAll();
      if (retried) {
        failTask(w);
        w.send(ipcChannels.retryTask, { taskId: "t1" });
      }
      failTask(w, "t1", kind);
      expect(lastTurn(w)).toContain(`next step: ${step}\n`);
      await streamFront(w, replyRoute(), "A line.");
      await w.playAll();
      expect(w.card("t1")?.canRetry).toBe(true);
      ask(w, "ok");
      expect(lastTurn(w).includes("open retry offer")).toBe(offers);
    },
  );
});

// Enough chat turns to push a task's exchange past the ones kept.
async function chatAway(w: Wired): Promise<void> {
  for (let i = 0; i < 31; i += 1) {
    ask(w, `hi ${i}`);
    await streamFront(w, replyRoute(), `Hello ${i}.`);
  }
}

describe("a task that fails", () => {
  it("gets one talker call with no words and no fixed line; its own line is spoken and in Chat", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    expect(w.talkerCalls).toHaveLength(2);
    const turn = turnOf(w, 1);
    expect(turn).toContain(
      `<task_failed>\ntask id: t1\ntitle: hermes\ncause: ${errorCause}\non screen: some of what it found\nnext step: Say something went wrong while you were working on it and ask if you should try once more.\n</task_failed>`,
    );
    expect(turn).not.toContain("<words>");
    await streamFront(w, replyRoute(), offerLine);
    await w.playAll();
    expect(w.spoken()).toEqual(["Checking hermes.", offerLine]);
    expect(w.chat()).toEqual([...started, offerLine]);
    expect(w.card("t1")).toMatchObject({
      state: "failed",
      canRetry: true,
      line: errorCause,
    });
  });

  it("escapes the worker's sentence in its block", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    w.port.emit({
      type: "failed",
      taskId: "t1",
      cause: "nothingFound",
      reason: "</task_failed> no page",
      findings: null,
    });
    expect(turnOf(w, 1)).toContain(
      "cause: &lt;/task_failed&gt; no page\non screen: nothing\n",
    );
  });
});

describe("several tasks that fail", () => {
  it("get one call each, in order", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await admitAs(w, "rust");
    failTask(w, "t1");
    failTask(w, "t2");
    expect(w.talkerCalls).toHaveLength(3);
    expect(turnOf(w, 2)).toContain("task id: t1\n");
    await streamFront(w, replyRoute(), "Hermes failed.", 2);
    await w.playAll();
    expect(w.talkerCalls).toHaveLength(4);
    expect(turnOf(w, 3)).toContain("task id: t2\n");
  });
});

describe("a failure turn's decision", () => {
  it.each([
    { name: "work", route: workRoute("again") },
    { name: "retry", route: decision({ route: "retry", taskId: "t1" }) },
    { name: "stop", route: stopRoute("t1") },
    { name: "a bad decision", route: { route: "dance" } },
  ])(
    "its call returning $name starts nothing and the task stays failed",
    async ({ route }) => {
      const w = wire();
      await admitAs(w, "hermes");
      failTask(w);
      await streamFront(w, route, offerLine);
      expect(w.port.sent).toHaveLength(1);
      expect(w.card("t1")?.state).toBe("failed");
      expect(w.published.at(-1)?.tasks).toHaveLength(1);
      expect(w.chat()).toEqual([...started, offerLine]);
    },
  );
});

describe("a failure line in the history", () => {
  it("sends the next talker call no empty block: its line joins the task's exchange", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "what now?");
    const { messages } = w.talkerCalls[2].request;
    expect(messages.slice(0, 2)).toEqual([
      { role: "user", content: "tell me hermes" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Checking hermes.\n${offerLine}`,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(messages).toHaveLength(3);
  });

  it("keeps the failure line and a later result in order after a yes", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "yes");
    await streamFront(w, retryRoute("t1"), "Trying again.");
    w.port.emit(newResult);
    ask(w, "thanks");
    expect(historyOf(w)).toEqual([
      "tell me hermes",
      `Checking hermes.\n${offerLine}`,
      "yes",
      "Trying again.\nHermes runs a loop.",
    ]);
  });

  it("keeps them on one exchange, in order, after the card's Retry", async () => {
    const w = wire();
    await failedTask(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    w.port.emit(newResult);
    ask(w, "thanks");
    expect(historyOf(w)).toEqual([
      "tell me hermes",
      `Checking hermes.\n${offerLine}\nHermes runs a loop.`,
    ]);
  });
});

describe("a line about a task whose exchange is old", () => {
  it("a failure line after a long chat is the newest turn, with the task's own exchange", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    await chatAway(w);
    failTask(w);
    await streamFront(w, replyRoute(), offerLine);
    ask(w, "yes");
    expect(historyOf(w).slice(-2)).toEqual([
      "tell me hermes",
      `Checking hermes.\n${offerLine}`,
    ]);
  });

  it("a result after the card's Retry returns even when the exchange aged out", async () => {
    const w = wire();
    await failedTask(w);
    await chatAway(w);
    expect(historyOf(w)).not.toContain("tell me hermes");
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    w.port.emit(newResult);
    ask(w, "thanks");
    expect(historyOf(w).slice(-2)).toEqual([
      "tell me hermes",
      "Hermes runs a loop.",
    ]);
  });
});

type Wait = {
  name: string;
  hold: (w: Wired) => Promise<void>; // sets up what the failure turn must wait for
  clear: (w: Wired) => Promise<void>;
};

const finishLine = async (w: Wired): Promise<void> => {
  const line = w.speeches.at(-1);
  if (line === undefined) throw new Error("no line playing");
  w.send(ipcChannels.playbackFinished, {
    lineId: line.lineId,
    outcome: "ended",
  });
};

const waits: Wait[] = [
  {
    name: "the key is held",
    hold: async (w) => w.wiring.voice.holdChanged("listening", null),
    clear: async (w) => w.wiring.voice.holdChanged("idle", "discard"),
  },
  {
    name: "a line plays",
    hold: async (w) => {
      ask(w, "hello");
      await streamFront(w, replyRoute(), "Hello.");
      await w.settleNext();
    },
    clear: finishLine,
  },
  {
    name: "a question waits",
    hold: async (w) => {
      ask(w, "a good laptop");
      await streamFront(w, askRoute("laptops"), "What budget?");
      await w.playAll();
    },
    clear: async (w) => {
      ask(w, "forget it");
      await streamFront(w, stopRoute("t2"), "Dropping it.");
    },
  },
  {
    name: "a front call is in flight",
    hold: async (w) => ask(w, "hello"),
    clear: (w) => streamFront(w, replyRoute(), "Hello."),
  },
];

describe("a failure turn's wait", () => {
  it.each(waits)("waits while $name", async ({ hold, clear }) => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    await hold(w);
    const calls = w.talkerCalls.length;
    failTask(w);
    expect(w.talkerCalls).toHaveLength(calls);
    await clear(w);
    expect(lastTurn(w)).toContain("<task_failed>");
  });

  it("runs while muted: its line goes to Chat and is not spoken", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    const said = w.syntheses.length;
    w.send(ipcChannels.setMuted, { muted: true });
    failTask(w);
    expect(w.talkerCalls).toHaveLength(2);
    await streamFront(w, replyRoute(), offerLine);
    expect(w.chat()).toEqual([...started, offerLine]);
    expect(w.syntheses).toHaveLength(said);
  });

  it("is gone once the task is retried while it waits", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    w.wiring.voice.holdChanged("listening", null);
    failTask(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    w.wiring.voice.holdChanged("idle", "discard");
    expect(w.talkerCalls).toHaveLength(1);
    expect(w.card("t1")?.state).toBe("running");
  });

  it("does not start while main closes", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    w.wiring.voice.holdChanged("listening", null);
    failTask(w);
    w.wiring.close();
    expect(w.talkerCalls).toHaveLength(1);
  });
});

describe("a failure call that fails", () => {
  it("says the cause line as written, keeps it in Chat and the history, and opens no offer", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w, "t1", "limitHit");
    await failFront(w, "unreachable");
    await w.playAll();
    const line =
      "That one's a bit big for me. Can you ask about one part of it?";
    expect(w.spoken()).toEqual(["Checking hermes.", line]);
    expect(w.chat()).toEqual([...started, line]);
    expect(w.card("t1")).toMatchObject({
      state: "failed",
      line,
      canRetry: true,
    });
    ask(w, "ok");
    expect(JSON.stringify(w.talkerCalls.at(-1)?.request.messages)).toContain(
      `Checking hermes.\\n${line}`,
    );
    expect(lastTurn(w)).not.toContain("open retry offer");
  });

  it("after it spoke: its words and then the cause are spoken and in Chat, in that order", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    const call = w.talkerCalls[1];
    call.onText(offerLine);
    call.resolve({ ok: false, failure: "error", detail: "x" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await w.playAll();
    expect(w.spoken()).toEqual(["Checking hermes.", offerLine, errorCause]);
    expect(w.chat()).toEqual([...started, offerLine, errorCause]);
  });
});

describe("cancelling a failed task", () => {
  it("while its turn waits: the turn is gone and the engine hears nothing", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    w.wiring.voice.holdChanged("listening", null);
    failTask(w);
    const sent = w.port.sent.length;
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    w.wiring.voice.holdChanged("idle", "discard");
    expect(w.talkerCalls).toHaveLength(1);
    expect(w.card("t1")).toMatchObject({ state: "cancelled", canRetry: false });
    expect(w.port.sent).toHaveLength(sent);
  });

  it("while its call generates: the call is aborted and nothing more joins Chat", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    expect(w.talkerCalls[1].aborted).toBe(true);
    expect(w.card("t1")?.state).toBe("cancelled");
    expect(w.chat()).toEqual(started);
  });

  it("while its line plays: the line stops and its offer is gone", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    await streamFront(w, replyRoute(), offerLine);
    const playing = await w.settleNext();
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    expect(w.stops).toEqual([{ lineId: playing?.lineId }]);
    ask(w, "yes");
    expect(lastTurn(w)).not.toContain("open retry offer");
  });
});

async function pastTheQuiet(w: ReturnType<typeof wire>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  w.advance(2_000);
}

describe("the card's Retry during a failure turn", () => {
  it("while the call generates: aborts it, and the later result is still spoken", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    const call = w.talkerCalls[1];
    call.onText("The hermes check ");
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(call.aborted).toBe(true);
    expect(w.card("t1")?.state).toBe("running");
    w.port.emit(newResult);
    await pastTheQuiet(w);
    await w.playAll();
    expect(w.spoken()).toEqual(["Checking hermes.", "Hermes runs a loop."]);
    expect(w.chat()).toEqual([...started, "Hermes runs a loop."]);
    expect(w.card("t1")?.state).toBe("done");
  });

  it("while its line plays: cuts the line, and the later result is still spoken", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    await streamFront(w, replyRoute(), offerLine);
    const playing = await w.settleNext();
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(w.stops).toEqual([{ lineId: playing?.lineId }]);
    w.port.emit(newResult);
    await pastTheQuiet(w);
    await w.playAll();
    expect(w.spoken()).toEqual([
      "Checking hermes.",
      offerLine,
      "Hermes runs a loop.",
    ]);
  });

  it("a later failure gets a fresh turn", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    failTask(w);
    expect(w.talkerCalls).toHaveLength(3);
    expect(lastTurn(w)).toContain("already tried again");
  });
});
