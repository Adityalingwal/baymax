import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import { askClarify, createHarness, newTask, questionIdOf } from "./harness";

type ReleaseRow = { name: string; release: (h: Harness) => void };

// Answers the first question by speech: the words' own card goes and the first task is admitted.
const answerFirst = (h: Harness) => {
  h.state.ask("the first one", null, h.state.waitingQuestion());
  h.reply(h.lastTaskId(), newTask("about it", questionIdOf("t1")));
};

const releaseRows: ReleaseRow[] = [
  { name: "the first is answered", release: answerFirst },
  { name: "the first is cancelled", release: (h) => h.state.cancelTask("t1") },
  {
    name: "the first is answered and then cancelled",
    release: (h) => {
      answerFirst(h);
      h.state.cancelTask("t1");
    },
  },
];

describe("the shown question", () => {
  it("shows the spoken line as the question and says nothing more, until it is answered", () => {
    const h = createHarness();
    askClarify(h);
    expect(h.card("t1")).toEqual({
      taskId: "t1",
      state: "clarifying",
      words: "about it",
      parentTaskId: null,
      sayBack: null,
      line: null,
      reply: null,
      spokenLine: null,
      step: null,
      sourcesRead: 0,
      question: {
        questionId: "t1:question",
        text: "Which one for t1?",
        choices: ["First", "Second", "Third"],
        answered: false,
      },
      answer: null,
      missing: null,
      canRetry: false,
    });
    expect(h.said).toEqual([]);
    expect(h.talked).toHaveLength(1);
    expect(h.state.waitingQuestion()).toEqual({
      taskId: "t1",
      words: "about it",
      question: {
        questionId: "t1:question",
        text: "Which one for t1?",
        choices: ["First", "Second", "Third"],
      },
    });
  });
});

describe("the question's other forms", () => {
  it("shows an open question with no choices", () => {
    const h = createHarness();
    askClarify(h, []);
    expect(h.card("t1")?.question).toMatchObject({ choices: [] });
    expect(h.state.waitingQuestion()?.question.choices).toEqual([]);
  });

  it("passes waiting into the front call unchanged", () => {
    const h = createHarness();
    const waiting = {
      taskId: "t7",
      words: "find me a laptop",
      question: { questionId: "q7", text: "Use?", choices: ["a", "b"] },
    };
    h.state.ask(" hi ", "u1", waiting);
    expect(h.talked.at(-1)).toEqual({
      kind: "front",
      attemptId: "t1#1",
      taskId: "t1",
      utteranceId: "u1",
      words: "hi",
      history: [],
      recent: [],
      tasks: [],
      waiting,
    });
  });
});

describe("a second question", () => {
  it.each(releaseRows)(
    "stays hidden, then shows and is said as given after $name",
    ({ release }) => {
      const h = createHarness();
      askClarify(h);
      askClarify(h);
      expect(h.card("t2")?.question).toBeNull();
      expect(h.said).toEqual([]);
      release(h);
      expect(h.state.waitingQuestion()).toMatchObject({ taskId: "t2" });
      expect(h.said).toEqual([
        { taskId: "t2", text: "Which one for t2?", kind: "question" },
      ]);
    },
  );

  it("lets words that do not answer go through as a new task while the question stays shown", () => {
    const h = createHarness();
    askClarify(h);
    h.state.ask("something else", null, h.state.waitingQuestion());
    h.reply("t2", newTask("rust"));
    expect(h.card("t2")?.state).toBe("running");
    expect(h.state.waitingQuestion()).toMatchObject({ taskId: "t1" });
  });
});

describe("cancelling a clarifying task", () => {
  it("ends it at once when no answer is in flight and shows the next question", () => {
    const h = createHarness();
    askClarify(h);
    askClarify(h);
    const sent = h.sent.length;
    h.state.cancelTask("t1");
    expect(h.card("t1")?.state).toBe("cancelled");
    expect(h.sent.length).toBe(sent);
    expect(h.card("t2")?.question).toMatchObject({
      questionId: "t2:question",
      answered: false,
    });
  });
});
