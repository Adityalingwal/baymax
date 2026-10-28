import { describe, expect, it } from "vitest";
import {
  askClarify,
  askNew,
  chat,
  clarify,
  click,
  counts,
  createHarness,
  decision,
  newTask,
  outsideResearch,
  waitingOf,
} from "./harness";

describe("how a clicked answer is routed", () => {
  it("admits the task with the words and the answer joined, whether or not the tool names the question", () => {
    for (const answerTo of [null, "t1:question"]) {
      const h = createHarness();
      askClarify(h, ["Office", "Gaming"], "find me a laptop");
      h.state.answerQuestion(click("t1", 0));
      h.reply("t1", newTask("office laptops", answerTo), "Checking laptops.");
      expect(h.card("t1")).toMatchObject({
        state: "running",
        reply: "Checking laptops.",
        sayBack: null,
        line: null,
        question: null,
      });
      expect(h.sent.at(-1)).toMatchObject({
        type: "runTask",
        taskId: "t1",
        brief: {
          goal: "office laptops",
          userWords: 'find me a laptop\nAnswer to "Which one for t1?": Office',
        },
      });
    }
  });
});

describe("how a clicked answer is routed when it is not a task", () => {
  it("ends the waiting task done with the line when the answer is chat, starting no worker", () => {
    const h = createHarness();
    askClarify(h);
    h.state.answerQuestion(click("t1"));
    h.reply("t1", chat(), "That works.");
    expect(h.card("t1")).toMatchObject({
      state: "done",
      reply: "That works.",
      answer: { cardText: "That works." },
      question: null,
    });
    expect(h.sent).toEqual([]);
    expect(h.said).toEqual([]);
  });

  it("ends the waiting task as outside research, saying nothing more", () => {
    const h = createHarness();
    askClarify(h);
    h.state.answerQuestion(click("t1"));
    h.reply("t1", outsideResearch(), "I only research.");
    expect(h.card("t1")).toMatchObject({
      state: "cancelled",
      reply: "I only research.",
      line: null,
    });
    expect(h.said).toEqual([]);
    expect(h.silenced).toEqual([]);
  });

  it.each([
    ["another question's id", decision({ ...newTask("x"), answerTo: "q9" })],
    [
      "a second clarifying question",
      decision({ ...clarify(), answerTo: null }),
    ],
  ])("fails with a retryable line for %s and starts nothing", (_name, raw) => {
    const h = createHarness();
    askClarify(h);
    h.state.answerQuestion(click("t1"));
    h.reply("t1", raw);
    expect(h.card("t1")).toMatchObject({
      state: "clarifying",
      line: "I hit an error on that question. Try again.",
      canRetry: true,
    });
    expect(h.sent).toEqual([]);
    expect(h.logs.at(-1)).toMatch(/^decision rejected for t1: /);
  });
});

describe("a spoken answer", () => {
  it.each([
    { admitted: 0, state: "running" },
    { admitted: 4, state: "cancelled" },
  ])(
    "removes the thinking card and routes the waiting task with $admitted tasks admitted",
    ({ admitted, state }) => {
      const h = createHarness();
      askClarify(h, ["Office", "Gaming"], "find me a laptop");
      for (let i = 0; i < admitted; i += 1) askNew(h, `task ${i}`);
      const waiting = waitingOf(h);
      h.state.ask("the second one", null, waiting);
      const temp = h.lastTaskId();
      h.reply(temp, newTask("gaming laptops", waiting.question.questionId));
      expect(h.card(temp)).toBeUndefined();
      expect(h.card("t1")).toMatchObject({
        state,
        question: null,
      });
      if (admitted === 0) {
        expect(h.sent.at(-1)).toMatchObject({
          type: "runTask",
          taskId: "t1",
          brief: {
            userWords:
              'find me a laptop\nAnswer to "Which one for t1?": the second one',
          },
        });
      }
    },
  );
});

describe("spoken answers that compete", () => {
  it("drops a second spoken answer to the same question and starts nothing for it", () => {
    const h = createHarness();
    askClarify(h);
    const waiting = waitingOf(h);
    const questionId = waiting.question.questionId;
    h.state.ask("the first one", null, waiting);
    h.state.ask("the second one", null, waiting);
    h.reply("t2", { ...chat(), answerTo: questionId }, "First wins.");
    h.reply("t3", newTask("x", questionId));
    expect(h.card("t3")).toBeUndefined();
    expect(h.card("t1")).toMatchObject({
      state: "done",
      reply: "First wins.",
    });
    expect(h.sent).toEqual([]);
  });
});

describe("a click against a spoken answer", () => {
  it("lets a click win over a spoken answer that arrives while its call is in flight", () => {
    const h = createHarness();
    askClarify(h, ["Office", "Gaming"]);
    const waiting = waitingOf(h);
    h.state.ask("the second one", null, waiting);
    h.state.answerQuestion(click("t1", 0));
    h.reply("t2", newTask("gaming", waiting.question.questionId));
    expect(h.card("t2")).toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(h.card("t1")).toMatchObject({ state: "clarifying" });
    h.reply("t1", newTask("office"));
    expect(h.sent.at(-1)).toMatchObject({ type: "runTask", taskId: "t1" });
    expect(h.sent.filter((c) => c.type === "runTask")).toHaveLength(1);
  });

  it("lets the first spoken answer win and drops a click afterwards", () => {
    const h = createHarness();
    askClarify(h);
    const waiting = waitingOf(h);
    h.state.ask("the second one", null, waiting);
    h.reply("t2", newTask("gaming", waiting.question.questionId));
    const before = counts(h);
    h.state.answerQuestion(click("t1", 0));
    expect(counts(h)).toEqual(before);
    expect(h.sent.filter((c) => c.type === "runTask")).toHaveLength(1);
  });

  it("starts nothing and keeps the question unclaimed when the answer is cancelled during its call", () => {
    const h = createHarness();
    askClarify(h);
    const waiting = waitingOf(h);
    h.state.ask("the second one", null, waiting);
    h.state.cancelTask("t2");
    h.state.talkerReplied("t2", "t2#1", {
      kind: "said",
      text: "ok",
      decision: newTask("x", waiting.question.questionId),
    });
    expect(h.card("t2")?.state).toBe("cancelled");
    expect(h.card("t1")).toMatchObject({
      state: "clarifying",
      question: { answered: false },
    });
    expect(h.sent).toEqual([]);
  });
});
