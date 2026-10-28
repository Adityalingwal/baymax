import { describe, expect, it } from "vitest";
import type { FailureKind } from "../../shared/engine";
import type { Harness } from "./harness";
import {
  briefParts,
  chat,
  clarify,
  createHarness,
  decision,
  followUp,
  newTask,
  outsideResearch,
  askNew,
} from "./harness";

const answerOf = (text: string) => ({
  cardText: text,
  sources: [],
  openPoints: [],
});

describe("the routes of a front decision", () => {
  it("chat: the thinking card becomes a done card showing the line, with no worker and nothing said", () => {
    const h = createHarness();
    h.state.ask("thanks!", null, null);
    h.reply("t1", chat(), "You're welcome!");
    expect(h.card("t1")).toMatchObject({
      state: "done",
      sayBack: null,
      line: null,
      reply: "You're welcome!",
      question: null,
      answer: answerOf("You're welcome!"),
    });
    expect(h.sent).toEqual([]);
    expect(h.said).toEqual([]);
    expect(h.talked.map((request) => request.kind)).toEqual(["front"]);
  });

  it("newTask: the card shows the line, starts the worker with the four brief parts and the words, and says nothing", () => {
    const h = createHarness();
    h.state.ask("  will it rain?  ", null, null);
    h.reply("t1", newTask("the forecast"), "I'll check the forecast.");
    expect(h.card("t1")).toMatchObject({
      state: "running",
      sayBack: null,
      line: null,
      reply: "I'll check the forecast.",
      question: null,
      parentTaskId: null,
    });
    expect(h.sent).toEqual([
      {
        type: "runTask",
        taskId: "t1",
        goalVersion: 1,
        depth: "normal",
        brief: { ...briefParts("the forecast"), userWords: "will it rain?" },
        parent: null,
      },
    ]);
    expect(h.said).toEqual([]);
  });
});

describe("the routes of a front decision that wait or end", () => {
  it("clarify: the card is clarifying with the line as the question and no reply, say-back or line", () => {
    const h = createHarness();
    h.state.ask("can you help me?", null, null);
    h.reply("t1", clarify([]), "What would you like me to look into?");
    expect(h.card("t1")).toMatchObject({
      state: "clarifying",
      sayBack: null,
      line: null,
      reply: null,
      question: {
        text: "What would you like me to look into?",
        choices: [],
        answered: false,
      },
    });
    expect(h.sent).toEqual([]);
    expect(h.said).toEqual([]);
  });

  it("outsideResearch: the card ends cancelled with the line, which stays spoken", () => {
    const h = createHarness();
    h.state.ask("book me a cab", null, null);
    h.reply("t1", outsideResearch(), "I can't book a cab.");
    expect(h.card("t1")).toMatchObject({
      state: "cancelled",
      reply: "I can't book a cab.",
      line: null,
      sayBack: null,
    });
    expect(h.sent).toEqual([]);
    expect(h.said).toEqual([]);
    expect(h.silenced).toEqual([]);
  });

  it("a follow-up naming an unknown task is admitted as a new task and logged", () => {
    const h = createHarness();
    h.state.ask("and more", null, null);
    h.reply("t1", followUp("t9", "more"));
    expect(h.card("t1")).toMatchObject({
      state: "running",
      parentTaskId: null,
    });
    expect(h.logs).toContain("t1 names parent t9; admitted as a new task");
  });
});

describe("the front call's timing and record", () => {
  it("publishes the thinking card, then asks the front call, and sends nothing to the engine", () => {
    const h = createHarness();
    h.state.ask("will it rain tomorrow?", "u1", null);
    expect(h.timeline).toEqual(["publish", "talk front t1"]);
    expect(h.talked[0]).toMatchObject({
      kind: "front",
      attemptId: "t1#1",
      taskId: "t1",
      utteranceId: "u1",
      words: "will it rain tomorrow?",
    });
    expect(h.sent).toEqual([]);
  });

  it("keeps the line as the answer the next question's record carries, and in its history", () => {
    const h = createHarness();
    h.state.ask("thanks!", null, null);
    h.reply("t1", chat(), "You're welcome!");
    h.state.ask("and the weather?", null, null);
    expect(h.talked.at(-1)).toMatchObject({
      recent: [{ taskId: "t1", answer: "You're welcome!" }],
      history: [
        { role: "user", text: "thanks!" },
        { role: "assistant", text: "You're welcome!" },
      ],
    });
  });

  it("drops a second reply to the same call", () => {
    const h = createHarness();
    askNew(h, "hermes");
    const published = h.published.length;
    h.state.talkerReplied("t1", "t1#1", {
      kind: "said",
      text: "again",
      decision: chat(),
    });
    expect(h.published).toHaveLength(published);
    expect(h.card("t1")).toMatchObject({ state: "running" });
    expect(h.logs.at(-1)).toBe("dropped: front call t1#1 for t1");
  });
});

type Fail = { name: string; fail: (h: Harness) => void; line: string };

const errorLine = "I hit an error on that question. Try again.";

const failures: Fail[] = [
  {
    name: "a failed call",
    fail: (h) => h.replyFailed("t1", "modelsUnreachable" as FailureKind),
    line: "I can't reach my models right now. Try again in a few minutes.",
  },
  {
    name: "a rejected key",
    fail: (h) => h.replyFailed("t1", "keyRejected"),
    line: "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
  },
  {
    name: "a call with no tool",
    fail: (h) => h.reply("t1", null, "It's four."),
    line: errorLine,
  },
  {
    name: "a decision that fails a check",
    fail: (h) => h.reply("t1", decision({ route: "newTask", topic: "x" })),
    line: errorLine,
  },
  {
    name: "an unknown route",
    fail: (h) => h.reply("t1", decision({ route: "dance" })),
    line: errorLine,
  },
];

describe("a front call that fails", () => {
  it.each(failures)(
    "$name shows the line for its cause with retry and starts no worker",
    ({ fail, line }) => {
      const h = createHarness();
      h.state.ask("what is 2 + 2?", null, null);
      fail(h);
      expect(h.card("t1")).toMatchObject({
        state: "thinking",
        line,
        canRetry: true,
        reply: null,
      });
      expect(h.said).toEqual([{ taskId: "t1", text: line, kind: "failure" }]);
      expect(h.sent).toEqual([]);
    },
  );
});
