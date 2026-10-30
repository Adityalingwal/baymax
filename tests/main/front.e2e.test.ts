import { describe, expect, it } from "vitest";
import type { ModelFailure } from "../../src/providers/anthropic";
import { ipcChannels } from "../../src/shared/ipc";
import { finished } from "./talker.harness";
import {
  replyRoute,
  askRoute,
  decision,
  findings,
  stopRoute,
  workOnRoute,
  workRoute,
} from "./tasks/harness";
import { admitAs, failFront, streamFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

// Everything said once speech has played out: the front call's own line, then main's lines.
async function spokenAll(w: Wired): Promise<string[]> {
  await flush();
  await w.playAll();
  return w.spoken();
}

const answerOf = (text: string) => ({
  cardText: text,
  sources: [],
});

describe("the routes of a front decision", () => {
  it("chat: the thinking card becomes a done card showing the line, with no worker and nothing more said", async () => {
    const w = wire();
    ask(w, "thanks!");
    await streamFront(w, replyRoute(), "You're welcome!");
    expect(w.card("t1")).toMatchObject({
      state: "done",
      sayBack: null,
      line: null,
      reply: "You're welcome!",
      question: null,
      answer: answerOf("You're welcome!"),
    });
    expect(w.port.sent).toEqual([]);
    expect(await spokenAll(w)).toEqual(["You're welcome!"]);
    expect(w.talkerCalls).toHaveLength(1);
  });

  it("newTask: the card shows the line, sends the goal and the words, and says nothing more", async () => {
    const w = wire();
    ask(w, "  will it rain?  ");
    await streamFront(w, workRoute("the forecast"), "I'll check the forecast.");
    expect(w.card("t1")).toMatchObject({
      state: "running",
      sayBack: null,
      line: null,
      reply: "I'll check the forecast.",
      question: null,
      parentTaskId: null,
    });
    expect(w.port.sent).toEqual([
      {
        type: "runTask",
        taskId: "t1",
        goalVersion: 1,
        depth: "normal",
        ask: { goal: "the forecast", userWords: "will it rain?" },
        parent: null,
      },
    ]);
    expect(await spokenAll(w)).toEqual(["I'll check the forecast."]);
  });
});

describe("the routes of a front decision that wait or end", () => {
  it("clarify: the card is clarifying with the line as the question and no reply, say-back or line", async () => {
    const w = wire();
    ask(w, "can you help me?");
    await streamFront(w, askRoute(), "What would you like me to look into?");
    expect(w.card("t1")).toMatchObject({
      state: "clarifying",
      sayBack: null,
      line: null,
      reply: null,
      question: {
        text: "What would you like me to look into?",
        answered: false,
      },
    });
    expect(w.port.sent).toEqual([]);
    expect(await spokenAll(w)).toEqual([
      "What would you like me to look into?",
    ]);
  });

  it("stop on a running task: the engine gets a cancel and the stop line finishes playing", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    ask(w, "stop that");
    await streamFront(w, stopRoute("t1"), "Stopping hermes.");
    expect(w.port.sent.at(-1)).toEqual({ type: "cancel", taskId: "t1" });
    expect(w.card("t1")?.state).toBe("cancelling");
    expect(await spokenAll(w)).toEqual([
      "Checking hermes.",
      "Stopping hermes.",
    ]);
    expect(w.stops).toEqual([]);
  });
});

describe("a follow-up of an unknown task", () => {
  it("a follow-up naming an unknown task is admitted as a new task and logged", async () => {
    const w = wire();
    ask(w, "and more");
    await streamFront(w, workOnRoute("t9", "more"));
    expect(w.card("t1")).toMatchObject({
      state: "running",
      parentTaskId: null,
    });
    expect(w.logs).toContain("t1 names parent t9; admitted as a new task");
  });
});

const missedLine = "Sorry, I missed that. Ask again.";
const stalledLine = "That didn't go through. Ask again.";

// The front call speaks its text, then fails or ends with no tool.
async function speakThen(w: Wired, text: string, end: ModelFailure | "noTool") {
  const call = w.talkerCalls.find((other) => !other.settled);
  if (call === undefined) throw new Error("no front call to settle");
  call.onText(text);
  call.resolve(
    end === "noTool"
      ? finished(text, [], "end_turn")
      : { ok: false, failure: end, detail: "x" },
  );
  await flush();
}

type Fail = {
  name: string;
  fail: (w: Wired) => Promise<void>;
  line: string;
  spoken: string[];
};

const failures: Fail[] = [
  {
    name: "a rejected key with nothing spoken",
    fail: (w) => failFront(w, "keyRejected"),
    line: "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
    spoken: [
      "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
    ],
  },
  {
    name: "no credit with nothing spoken",
    fail: (w) => failFront(w, "noCredit"),
    line: "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
    spoken: [
      "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
    ],
  },
  {
    name: "unreachable models with nothing spoken",
    fail: (w) => failFront(w, "unreachable"),
    line: missedLine,
    spoken: [missedLine],
  },
  {
    name: "an error with nothing spoken",
    fail: (w) => failFront(w, "error"),
    line: missedLine,
    spoken: [missedLine],
  },
  {
    name: "an error after the line was spoken",
    fail: (w) => speakThen(w, "I'll check laptops.", "error"),
    line: stalledLine,
    spoken: ["I'll check laptops.", stalledLine],
  },
  {
    name: "unreachable models after the line was spoken",
    fail: (w) => speakThen(w, "I'll check.", "unreachable"),
    line: stalledLine,
    spoken: ["I'll check.", stalledLine],
  },
  {
    name: "a call with no tool",
    fail: (w) => speakThen(w, "It's four.", "noTool"),
    line: stalledLine,
    spoken: ["It's four.", stalledLine],
  },
  {
    name: "a decision that fails a check",
    fail: (w) => streamFront(w, decision({ route: "newTask", topic: "x" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "a decision with only its route",
    fail: (w) => streamFront(w, { route: "newTask" }),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "an unknown route",
    fail: (w) => streamFront(w, decision({ route: "dance" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "route retry, not built yet",
    fail: (w) => streamFront(w, decision({ route: "retry", taskId: "t1" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "a stop naming no task",
    fail: (w) => streamFront(w, decision({ route: "stop" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "a stop naming a task that is not running",
    fail: (w) => streamFront(w, stopRoute("t9")),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
];

const counts = (w: Wired) => [
  w.published.length,
  w.talkerCalls.length,
  w.port.sent.length,
  w.syntheses.length,
];

describe("a front call that fails", () => {
  it.each(failures)(
    "$name shows the line for its cause with retry and starts no worker",
    async ({ fail, line, spoken }) => {
      const w = wire();
      ask(w, "what is 2 + 2?");
      await fail(w);
      expect(w.card("t1")).toMatchObject({
        state: "thinking",
        line,
        canRetry: true,
        reply: null,
      });
      expect(await spokenAll(w)).toEqual(spoken);
      expect(w.port.sent).toEqual([]);
    },
  );

  it.each(failures)(
    "retry after $name re-runs the same request as a fresh call, once",
    async ({ fail }) => {
      const w = wire();
      ask(w, "what is 2 + 2?");
      await fail(w);
      const published = w.published.length;
      w.send(ipcChannels.retryTask, { taskId: "t1" });
      expect(w.talkerCalls).toHaveLength(2);
      expect(w.talkerCalls[1].request).toEqual(w.talkerCalls[0].request);
      expect(w.published.length).toBe(published + 1);
      expect(w.card("t1")).toMatchObject({ line: null, canRetry: false });
      const before = counts(w);
      w.send(ipcChannels.retryTask, { taskId: "t1" });
      expect(counts(w)).toEqual(before);
    },
  );
});

describe("the result of a retried front call", () => {
  it("takes only the retry's own result: the failed call's late result is dropped", async () => {
    const w = wire();
    ask(w, "what is 2 + 2?");
    await failFront(w, "error");
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    w.wiring.state.talkerReplied("t1", "t1#1", {
      kind: "said",
      text: "late",
      decision: replyRoute(),
    });
    expect(w.card("t1")).toMatchObject({ state: "thinking", reply: null });
    await streamFront(w, replyRoute(), "It's four.");
    expect(w.card("t1")).toMatchObject({
      state: "done",
      reply: "It's four.",
      line: null,
      canRetry: false,
    });
  });

  it("drops a retry after the card was cancelled, and a retry of a call that is still in flight", async () => {
    const w = wire();
    ask(w, "hi");
    const before = counts(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(counts(w)).toEqual(before);
    await failFront(w, "error");
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    const ended = counts(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(counts(w)).toEqual(ended);
  });
});

const progress = (taskId: string) =>
  ({
    type: "progress",
    taskId,
    step: { tool: "search", query: "q" },
    sourcesRead: 2,
  }) as const;

const result = (taskId: string, text = "Done.") =>
  ({
    type: "result",
    taskId,
    spokenLine: text,
    findings: findings(text),
  }) as const;

const cancelledEvent = (taskId: string) =>
  ({ type: "cancelled", taskId, findings: null }) as const;

type LateRow = {
  name: string;
  setup: (w: Wired) => Promise<void>;
  act: (w: Wired) => void;
};

const lateRows: LateRow[] = [
  {
    name: "progress for an unknown id",
    setup: async () => undefined,
    act: (w) => w.port.emit(progress("t9")),
  },
  {
    name: "a result for a done task",
    setup: async (w) => {
      await admitAs(w, "hermes");
      w.port.emit(result("t1"));
    },
    act: (w) => w.port.emit(result("t1", "Again.")),
  },
  {
    name: "progress while cancelling",
    setup: async (w) => {
      await admitAs(w, "hermes");
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
    },
    act: (w) => w.port.emit(progress("t1")),
  },
  {
    name: "a second cancelled",
    setup: async (w) => {
      await admitAs(w, "hermes");
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
      w.port.emit(cancelledEvent("t1"));
    },
    act: (w) => w.port.emit(cancelledEvent("t1")),
  },
  {
    name: "a second reply to a running task's front call",
    setup: (w) => admitAs(w, "hermes"),
    act: (w) =>
      w.wiring.state.talkerReplied("t1", "t1#1", {
        kind: "said",
        text: "again",
        decision: replyRoute(),
      }),
  },
  {
    name: "a front failure for a running task",
    setup: (w) => admitAs(w, "hermes"),
    act: (w) =>
      w.wiring.state.talkerReplied("t1", "t1#1", {
        kind: "failed",
        failure: "error",
      }),
  },
  {
    name: "a cancelled event for a queued task",
    setup: async (w) => {
      await admitAs(w, "hermes");
      await admitAs(w, "rust");
    },
    act: (w) => w.port.emit(cancelledEvent("t2")),
  },
  {
    name: "empty words",
    setup: async () => undefined,
    act: (w) => ask(w, "   "),
  },
];

describe("an input that changes nothing", () => {
  it.each(lateRows)(
    "$name publishes, sends and says nothing",
    async ({ setup, act }) => {
      const w = wire();
      await setup(w);
      const before = counts(w);
      act(w);
      await flush();
      expect(counts(w)).toEqual(before);
    },
  );

  it("logs a second reply to the same front call as dropped", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    w.wiring.state.talkerReplied("t1", "t1#1", {
      kind: "said",
      text: "again",
      decision: replyRoute(),
    });
    expect(w.card("t1")).toMatchObject({ state: "running" });
    expect(w.logs.at(-1)).toBe("dropped: front call t1#1 for t1");
  });
});
