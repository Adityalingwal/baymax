import { describe, expect, it } from "vitest";
import { ipcChannels } from "../../src/shared/ipc";
import {
  askRoute,
  decision,
  findings,
  replyRoute,
  stopRoute,
  workRoute,
} from "./tasks/harness";
import { admitAs, streamFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const failureAfterSpeech =
  "Something went wrong on my side, so nothing started. Ask again.";

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

// Asks and answers the front call with a question; the record is the next t id.
async function askClarify(w: Wired, words = "about it") {
  ask(w, words);
  const taskId = w.lastId();
  const call = w.talkerCalls.length - 1;
  await streamFront(w, askRoute(), `Which one for ${taskId}?`, call);
  return taskId;
}

// Typed words while a question waits; the front call answers them with the decision.
async function answerWith(
  w: Wired,
  words: string,
  route: unknown,
  line?: string,
) {
  ask(w, words);
  await streamFront(w, route, line, w.talkerCalls.length - 1);
}

const synthesized = (w: Wired, text: string) =>
  w.syntheses.filter((call) => call.input === text).length;

const lastTurn = (w: Wired, call: number) =>
  String(w.talkerCalls[call].request.messages.at(-1)?.content);

describe("a waiting question", () => {
  it("has no card, is said once and goes to the Chat list", async () => {
    const w = wire();
    await askClarify(w);
    expect(w.published.at(-1)?.tasks).toEqual([]);
    await flush();
    await w.playAll();
    expect(w.spoken()).toEqual(["Which one for t1?"]);
    expect(w.talkerCalls).toHaveLength(1);
    expect(w.chat()).toEqual(["about it", "Which one for t1?"]);
    expect(w.wiring.state.waitingQuestion()).toEqual({
      taskId: "t1",
      words: "about it",
      question: { questionId: "t1:question", text: "Which one for t1?" },
    });
  });

  it("may have no topic when there is no request yet", async () => {
    const w = wire();
    ask(w, "can you help me?");
    await streamFront(w, askRoute(null), "With what?");
    expect(w.wiring.state.waitingQuestion()?.question.text).toBe("With what?");
  });

  it("reaches the next call with its ids, request and question", async () => {
    const w = wire();
    await askClarify(w, "a <laptop>");
    ask(w, "the first");
    expect(lastTurn(w, 1)).toContain(
      "<waiting_question>\ntask id: t1\nquestion id: t1:question\nrequest: a &lt;laptop&gt;\nquestion: Which one for t1?\n</waiting_question>",
    );
  });
});

describe("two spoken questions", () => {
  it("makes the latest the active one", async () => {
    const w = wire();
    await askClarify(w);
    await askClarify(w);
    expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t2" });
  });

  it("orders them as spoken when the first call's decision comes last", async () => {
    const w = wire();
    ask(w, "a laptop");
    ask(w, "a hotel");
    await streamFront(w, askRoute(), "Which city?", 1);
    await streamFront(w, askRoute(), "What budget?", 0);
    expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t2" });
    await flush();
    await w.playAll();
    expect(w.spoken()).toEqual(["What budget?", "Which city?"]);
    await answerWith(w, "in Delhi", workRoute("hotels", "t2:question"));
    expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t1" });
    await flush();
    await w.playAll();
    expect(synthesized(w, "What budget?")).toBe(2);
    expect(synthesized(w, "Which city?")).toBe(1);
  });
});

describe("the older of two spoken questions", () => {
  it.each([
    {
      name: "the latest is answered",
      release: (w: Wired) =>
        answerWith(w, "the first", workRoute("it", "t2:question")),
      chat: ["the first", "Okay.", "Which one for t1?"],
    },
    {
      name: "the latest is stopped",
      release: (w: Wired) => answerWith(w, "drop it", stopRoute("t2")),
      chat: ["Which one for t1?"],
    },
  ])(
    "re-asks the older once and shows it in Chat when $name",
    async ({ release, chat }) => {
      const w = wire();
      await askClarify(w);
      await askClarify(w);
      await flush();
      await w.playAll();
      expect(synthesized(w, "Which one for t1?")).toBe(1);
      await release(w);
      expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t1" });
      await flush();
      await w.playAll();
      expect(synthesized(w, "Which one for t1?")).toBe(2);
      expect(w.chat().slice(4)).toEqual(chat);
      // Later changes do not ask it again.
      await admitAs(w, "rust");
      await flush();
      await w.playAll();
      expect(synthesized(w, "Which one for t1?")).toBe(2);
    },
  );
});

describe("an answer with two questions spoken", () => {
  it("binds to the latest", async () => {
    const w = wire();
    await askClarify(w, "first request");
    await askClarify(w, "second request");
    await answerWith(w, "the second one", workRoute("it", "t2:question"));
    expect(w.card("t2")).toMatchObject({ state: "running", title: "it" });
    expect(w.card("t1")).toBeUndefined();
  });

  it("starts nothing when its question stopped being the active one", async () => {
    const w = wire();
    await askClarify(w);
    ask(w, "the first");
    const answering = w.talkerCalls.length - 1;
    await askClarify(w);
    await streamFront(w, workRoute("it", "t1:question"), "Okay.", answering);
    expect(w.port.sent).toEqual([]);
    expect(w.published.at(-1)?.tasks).toEqual([]);
    expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t3" });
  });

  it("lets words that do not answer go through as new work while the question waits", async () => {
    const w = wire();
    await askClarify(w);
    await answerWith(w, "something else", workRoute("rust"));
    expect(w.card("t2")?.state).toBe("running");
    expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t1" });
  });
});

describe("an answer", () => {
  it("as a reply ends the waiting record with no card and no worker", async () => {
    const w = wire();
    await askClarify(w);
    await answerWith(w, "the first", replyRoute("t1:question"), "That works.");
    expect(w.published.at(-1)?.tasks).toEqual([]);
    expect(w.port.sent).toEqual([]);
    expect(w.wiring.state.waitingQuestion()).toBeNull();
    expect(w.chat().slice(2)).toEqual(["the first", "That works."]);
    await flush();
    await w.playAll();
    expect(w.spoken()).toEqual(["Which one for t1?", "That works."]);
  });
});

describe("an answer that is work", () => {
  it.each([
    { admitted: 0, state: "running" },
    { admitted: 1, state: "queued" },
  ])(
    "as work shows the waiting record $state with the topic, with $admitted task admitted",
    async ({ admitted, state }) => {
      const w = wire();
      await askClarify(w, "find me a laptop");
      for (let i = 0; i < admitted; i += 1) await admitAs(w, `task ${i}`);
      await answerWith(
        w,
        "the second one",
        workRoute("gaming laptops", "t1:question"),
        "Okay, gaming ones.",
      );
      expect(w.card("t1")).toMatchObject({
        state,
        title: "gaming laptops",
        words: "find me a laptop",
      });
      expect(w.published.at(-1)?.tasks).toHaveLength(admitted + 1);
      expect(w.wiring.state.waitingQuestion()).toBeNull();
      expect(w.chat().slice(-2)).toEqual([
        "the second one",
        "Okay, gaming ones.",
      ]);
      if (admitted === 0) {
        expect(w.port.sent.at(-1)).toMatchObject({
          type: "runTask",
          taskId: "t1",
          ask: {
            goal: "gaming laptops",
            userWords:
              'find me a laptop\nAnswer to "Which one for t1?": the second one',
          },
        });
      }
    },
  );
});

describe("an answer that goes wrong or goes on", () => {
  it("is rejected when it asks again, and starts nothing", async () => {
    const w = wire();
    await askClarify(w);
    await answerWith(
      w,
      "the first",
      decision({ route: "ask", answerTo: "t1:question" }),
      "Which first?",
    );
    expect(w.logs).toContain("decision rejected for t2: askAfterAnswer");
    expect(w.published.at(-1)?.tasks).toEqual([]);
    expect(w.port.sent).toEqual([]);
    expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t1" });
    expect(w.chat().at(-1)).toBe(failureAfterSpeech);
    await flush();
    await w.playAll();
    expect(w.spoken().at(-1)).toBe(failureAfterSpeech);
  });

  it("continues to done in one front call", async () => {
    const w = wire();
    await askClarify(w);
    await answerWith(
      w,
      "the cheaper one",
      workRoute("about it", "t1:question"),
      "Checking.",
    );
    expect(w.talkerCalls).toHaveLength(2);
    expect(w.port.sent.map((command) => command.type)).toEqual(["runTask"]);
    w.port.emit({
      type: "result",
      taskId: "t1",
      spokenLine: "The answer. spoken",
      findings: findings("The answer."),
    });
    expect(w.published.at(-1)?.tasks).toEqual([
      expect.objectContaining({
        taskId: "t1",
        state: "done",
        answer: expect.objectContaining({ cardText: "The answer." }),
      }),
    ]);
  });
});

describe("a question that goes away", () => {
  it("does not cut an unrelated call that started while it waited", async () => {
    const w = wire();
    await askClarify(w);
    ask(w, "tell me rust");
    const unrelated = w.talkerCalls.length - 1;
    const taskId = w.lastId();
    await answerWith(w, "the first", replyRoute("t1:question"), "That works.");
    expect(w.wiring.state.waitingQuestion()).toBeNull();
    expect(w.talkerCalls[unrelated].aborted).toBe(false);
    await streamFront(w, workRoute("rust"), "Checking rust.", unrelated);
    expect(w.card(taskId)).toMatchObject({ state: "running", title: "rust" });
  });

  it("makes a late answer to it start nothing", async () => {
    const w = wire();
    await askClarify(w);
    ask(w, "the first one");
    ask(w, "the second one");
    await streamFront(w, replyRoute("t1:question"), "First wins.", 1);
    await streamFront(w, workRoute("x", "t1:question"), "Okay.", 2);
    expect(w.published.at(-1)?.tasks).toEqual([]);
    expect(w.port.sent).toEqual([]);
    expect(w.logs).toContain("answer t1:question for t3 is stale");
  });

  it("is gone once stopped: later words are not bound to it", async () => {
    const w = wire();
    await askClarify(w);
    await flush();
    await w.playAll();
    await answerWith(w, "never mind", stopRoute("t1"), "Dropping that.");
    expect(w.wiring.state.waitingQuestion()).toBeNull();
    expect(w.published.at(-1)?.tasks).toEqual([]);
    expect(w.chat()).toEqual(["about it", "Which one for t1?"]);
    await flush();
    await w.playAll();
    expect(w.spoken()).toEqual(["Which one for t1?", "Dropping that."]);
    ask(w, "the first one");
    expect(lastTurn(w, 2)).toContain("<waiting_question>\nnone\n");
    await streamFront(w, workRoute("x", "t1:question"), "Okay.", 2);
    expect(w.logs).toContain("decision rejected for t3: answerWithoutWaiting");
    expect(w.port.sent).toEqual([]);
  });
});
