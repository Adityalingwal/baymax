import { describe, expect, it } from "vitest";
import type { AnswerQuestion } from "../../shared/ipc";
import type { Harness } from "./harness";
import {
  askClarify,
  askNew,
  click,
  counts,
  createHarness,
  finish,
  newTask,
  questionIdOf,
} from "./harness";

type DroppedRow = {
  name: string;
  setup: (h: Harness) => void;
  payload: AnswerQuestion;
};

const droppedRows: DroppedRow[] = [
  {
    name: "a second click",
    setup: (h) => h.state.answerQuestion(click("t1")),
    payload: click("t1", 1),
  },
  {
    name: "a second click after the answer failed",
    setup: (h) => {
      h.state.answerQuestion(click("t1"));
      h.replyFailed("t1", "error");
    },
    payload: click("t1", 1),
  },
  {
    name: "a late answer",
    setup: (h) => h.state.cancelTask("t1"),
    payload: click("t1"),
  },
  {
    name: "a wrong question id",
    setup: () => undefined,
    payload: click("t1", 0, "q9"),
  },
  {
    name: "an out-of-range choice",
    setup: () => undefined,
    payload: click("t1", 3),
  },
  {
    name: "blank text",
    setup: () => undefined,
    payload: {
      taskId: "t1",
      questionId: questionIdOf("t1"),
      reply: { kind: "text", text: "  " },
    },
  },
  {
    name: "an answer to a hidden question",
    setup: (h) => askClarify(h),
    payload: click("t2"),
  },
];

type ReleaseRow = { name: string; release: (h: Harness) => void };

const releaseRows: ReleaseRow[] = [
  {
    name: "the first is answered",
    release: (h) => h.state.answerQuestion(click("t1")),
  },
  { name: "the first is cancelled", release: (h) => h.state.cancelTask("t1") },
  {
    name: "the first is answered and then cancelled",
    release: (h) => {
      h.state.answerQuestion(click("t1"));
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
      folded: false,
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
    h.state.answerQuestion(click("t1"));
    expect(h.state.waitingQuestion()).toBeNull();
    expect(h.card("t1")?.question?.answered).toBe(true);
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

describe("binding a click", () => {
  it("runs the front call with the chosen text, the question as waiting, the history and the recent tasks", () => {
    const h = createHarness();
    finish(h, askNew(h, "hermes"));
    askClarify(h, ["Office", "Gaming"]);
    h.state.answerQuestion(click("t2", 1));
    expect(h.talked.at(-1)).toEqual({
      kind: "front",
      attemptId: "t2#2",
      taskId: "t2",
      utteranceId: null,
      words: "Gaming",
      history: [
        { role: "user", text: "tell me hermes" },
        { role: "assistant", text: "Checking hermes.\nDone. spoken" },
        { role: "user", text: "about it" },
        { role: "assistant", text: "Which one for t2?" },
      ],
      recent: [
        {
          taskId: "t1",
          state: "done",
          question: "tell me hermes",
          answer: "Done. spoken",
          cardText: "Done.",
        },
      ],
      tasks: [],
      waiting: {
        taskId: "t2",
        words: "about it",
        question: {
          questionId: "t2:question",
          text: "Which one for t2?",
          choices: ["Office", "Gaming"],
        },
      },
    });
    expect(h.sent).toHaveLength(1);
  });
});

describe("an answer that is dropped", () => {
  it.each(droppedRows)("drops $name", ({ setup, payload }) => {
    const h = createHarness();
    askClarify(h);
    setup(h);
    const before = counts(h);
    h.state.answerQuestion(payload);
    expect(counts(h)).toEqual(before);
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

  it("aborts the front call at once, with no engine message, when an answer is in flight", () => {
    const h = createHarness();
    askClarify(h);
    h.state.answerQuestion(click("t1"));
    h.state.cancelTask("t1");
    expect(h.card("t1")?.state).toBe("cancelled");
    expect(h.cancelled).toEqual(["t1#2"]);
    expect(h.sent).toEqual([]);
  });
});
