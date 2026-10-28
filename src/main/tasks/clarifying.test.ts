import { describe, expect, it } from "vitest";
import type { AnswerQuestion } from "../../shared/ipc";
import type { Harness } from "./harness";
import {
  askClarify,
  askNew,
  counts,
  createHarness,
  finish,
  intake,
  newTask,
  question,
} from "./harness";

function click(taskId: string, questionId: string, index = 0): AnswerQuestion {
  return { taskId, questionId, reply: { kind: "choice", index } };
}

function answerRoute(h: Harness, taskId: string, questionId: string): void {
  h.state.receive(
    intake(taskId, {
      route: "answer",
      waitingTaskId: "t1",
      questionId,
      reply: { kind: "choice", index: 1 },
    }),
  );
}

type DroppedRow = {
  name: string;
  setup: (h: Harness) => void;
  payload: AnswerQuestion;
};

const droppedRows: DroppedRow[] = [
  {
    name: "a second click",
    setup: (h) => h.state.answerQuestion(click("t1", "q1")),
    payload: click("t1", "q1", 1),
  },
  {
    name: "a second click after the answer failed",
    setup: (h) => {
      h.state.answerQuestion(click("t1", "q1"));
      h.state.receive({ type: "failure", taskId: "t1", kind: "error" });
    },
    payload: click("t1", "q1", 1),
  },
  {
    name: "a late answer",
    setup: (h) => h.state.cancelTask("t1"),
    payload: click("t1", "q1"),
  },
  {
    name: "a wrong question id",
    setup: () => undefined,
    payload: click("t1", "q9"),
  },
  {
    name: "an out-of-range choice",
    setup: () => undefined,
    payload: click("t1", "q1", 3),
  },
  {
    name: "blank text",
    setup: () => undefined,
    payload: {
      taskId: "t1",
      questionId: "q1",
      reply: { kind: "text", text: "  " },
    },
  },
  {
    name: "an answer to a hidden question",
    setup: (h) => askClarify(h, "q2"),
    payload: click("t2", "q2"),
  },
];

type ReleaseRow = { name: string; release: (h: Harness) => void };

const releaseRows: ReleaseRow[] = [
  {
    name: "the first is answered",
    release: (h) => h.state.answerQuestion(click("t1", "q1")),
  },
  { name: "the first is cancelled", release: (h) => h.state.cancelTask("t1") },
  {
    name: "the first task ends from cancelling",
    release: (h) => {
      h.state.answerQuestion(click("t1", "q1"));
      h.state.cancelTask("t1");
      h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
    },
  },
];

describe("the shown question", () => {
  it("shows and says a clarify outcome's question until it is answered", () => {
    const h = createHarness();
    askClarify(h, "q1");
    expect(h.card("t1")).toEqual({
      taskId: "t1",
      state: "clarifying",
      words: "about q1",
      parentTaskId: null,
      sayBack: "about q1",
      line: null,
      reply: null,
      step: null,
      sourcesRead: 0,
      question: { ...question("q1"), answered: false },
      answer: null,
      missing: null,
      canRetry: false,
      folded: false,
    });
    // The talker says the question in its own words; the card shows it in full.
    expect(h.talked.at(-1)).toEqual({
      kind: "question",
      taskId: "t1",
      question: "Question q1?",
      choices: question("q1").choices,
    });
    expect(h.state.waitingQuestion()).toEqual({
      taskId: "t1",
      question: question("q1"),
    });
    h.state.answerQuestion(click("t1", "q1"));
    expect(h.state.waitingQuestion()).toBeNull();
    expect(h.card("t1")?.question?.answered).toBe(true);
  });

  it("passes waiting into the question command unchanged", () => {
    const h = createHarness();
    const waiting = { taskId: "t7", question: question("q7") };
    h.state.ask(" hi ", "u1", waiting);
    expect(h.sent.at(-1)).toEqual({
      type: "question",
      taskId: "t1",
      utteranceId: "u1",
      words: "hi",
      recent: [],
      waiting,
    });
  });
});

describe("binding an answer", () => {
  it("binds a click and sends clarifyingAnswer with the task's words", () => {
    const h = createHarness();
    finish(h, askNew(h, "hermes"));
    askClarify(h, "q2");
    h.state.answerQuestion(click("t2", "q2", 1));
    expect(h.sent.at(-1)).toEqual({
      type: "clarifyingAnswer",
      taskId: "t2",
      words: "about q2",
      question: question("q2"),
      reply: { kind: "choice", index: 1 },
      recent: [
        {
          taskId: "t1",
          state: "done",
          question: "tell me hermes",
          answer: "Done. spoken",
          cardText: "Done.",
        },
      ],
    });
  });

  it.each(droppedRows)("drops $name", ({ setup, payload }) => {
    const h = createHarness();
    askClarify(h, "q1");
    setup(h);
    const before = counts(h);
    h.state.answerQuestion(payload);
    expect(counts(h)).toEqual(before);
  });
});

describe("a second question", () => {
  it.each(releaseRows)(
    "stays hidden, then shows and is said after $name",
    ({ release }) => {
      const h = createHarness();
      askClarify(h, "q1");
      askClarify(h, "q2");
      expect(h.card("t2")?.question).toBeNull();
      const questions = () => h.talked.filter((r) => r.kind === "question");
      expect(questions()).toHaveLength(1);
      release(h);
      expect(h.state.waitingQuestion()).toEqual({
        taskId: "t2",
        question: question("q2"),
      });
      expect(questions().filter((r) => r.taskId === "t2")).toEqual([
        {
          kind: "question",
          taskId: "t2",
          question: "Question q2?",
          choices: question("q2").choices,
        },
      ]);
    },
  );

  it("lets words that do not answer go through as a new task while the question stays shown", () => {
    const h = createHarness();
    askClarify(h, "q1");
    h.state.ask("something else", null, h.state.waitingQuestion());
    h.state.receive(intake("t2", newTask("rust")));
    expect(h.card("t2")?.state).toBe("running");
    expect(h.state.waitingQuestion()).toEqual({
      taskId: "t1",
      question: question("q1"),
    });
  });
});

describe("the answer route", () => {
  it.each([0, 4])(
    "deletes the thinking card and binds, with %i tasks admitted",
    (admitted) => {
      const h = createHarness();
      askClarify(h, "q1");
      for (let i = 0; i < admitted; i += 1) askNew(h, `task ${i}`);
      const states = h.last().tasks.map((card) => card.state);
      h.state.ask("the second one", null, h.state.waitingQuestion());
      answerRoute(h, h.lastTaskId(), "q1");
      expect(h.card(h.lastTaskId())).toBeUndefined();
      expect(h.last().tasks.map((card) => card.state)).toEqual(states);
      expect(h.sent.at(-1)).toMatchObject({
        type: "clarifyingAnswer",
        taskId: "t1",
      });
      expect(h.card("t1")?.question?.answered).toBe(true);
    },
  );

  it("deletes the thinking card of a late answer and sends nothing", () => {
    const h = createHarness();
    askClarify(h, "q1");
    h.state.answerQuestion(click("t1", "q1"));
    h.state.ask("the second one", null, null);
    const sent = h.sent.length;
    answerRoute(h, "t2", "q1");
    expect(h.card("t2")).toBeUndefined();
    expect(h.sent.length).toBe(sent);
  });
});

describe("cancelling a clarifying task", () => {
  it("ends it at once when no answer is in flight and shows the next question", () => {
    const h = createHarness();
    askClarify(h, "q1");
    askClarify(h, "q2");
    const sent = h.sent.length;
    h.state.cancelTask("t1");
    expect(h.card("t1")?.state).toBe("cancelled");
    expect(h.sent.length).toBe(sent);
    expect(h.card("t2")?.question).toEqual({
      ...question("q2"),
      answered: false,
    });
  });

  it("sends cancel when an answer is in flight", () => {
    const h = createHarness();
    askClarify(h, "q1");
    h.state.answerQuestion(click("t1", "q1"));
    h.state.cancelTask("t1");
    expect(h.card("t1")?.state).toBe("cancelling");
    expect(h.sent.at(-1)).toEqual({ type: "cancel", taskId: "t1" });
  });
});
