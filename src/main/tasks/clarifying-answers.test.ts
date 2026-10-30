import { describe, expect, it } from "vitest";
import {
  askClarify,
  askNew,
  chat,
  createHarness,
  newTask,
  outsideResearch,
  waitingOf,
} from "./harness";

describe("how a spoken answer is routed when it is not a task", () => {
  it("ends the waiting task done with the line when the answer is chat, starting no worker", () => {
    const h = createHarness();
    askClarify(h);
    const waiting = waitingOf(h);
    h.state.ask("the first one", null, waiting);
    h.reply(
      "t2",
      { ...chat(), answerTo: waiting.question.questionId },
      "That works.",
    );
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
    const waiting = waitingOf(h);
    h.state.ask("the first one", null, waiting);
    h.reply(
      "t2",
      { ...outsideResearch(), answerTo: waiting.question.questionId },
      "I only research.",
    );
    expect(h.card("t1")).toMatchObject({
      state: "cancelled",
      reply: "I only research.",
      line: null,
    });
    expect(h.said).toEqual([]);
    expect(h.silenced).toEqual([]);
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
          ask: {
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

describe("a spoken answer cancelled during its call", () => {
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
