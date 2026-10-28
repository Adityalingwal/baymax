import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import {
  askClarify,
  createHarness,
  finish,
  newTask,
  questionIdOf,
} from "./harness";

type AnswerRow = {
  name: string;
  answer: (h: Harness) => void;
  words: string;
};

const rows: AnswerRow[] = [
  {
    name: "a click",
    words: "Second",
    answer: (h) => {
      h.state.answerQuestion({
        taskId: "t1",
        questionId: questionIdOf("t1"),
        reply: { kind: "choice", index: 1 },
      });
      h.reply("t1", newTask("about it"), "Checking.");
    },
  },
  {
    name: "typed words",
    words: "the cheaper one",
    answer: (h) => {
      h.state.ask("the cheaper one", null, h.state.waitingQuestion());
      h.reply("t2", newTask("about it", questionIdOf("t1")), "Checking.");
    },
  },
  {
    name: "voice",
    words: "the third one",
    answer: (h) => {
      const snapshot = h.state.waitingQuestion();
      expect(snapshot?.question.questionId).toBe("t1:question");
      h.state.ask("the third one", "u1", snapshot);
      h.reply("t2", newTask("about it", questionIdOf("t1")), "Checking.");
    },
  },
];

describe("a clarifying task answered end to end", () => {
  it.each(rows)(
    "continues to done in one front call when answered by $name",
    ({ answer, words }) => {
      const h = createHarness();
      askClarify(h);
      answer(h);
      // One call for the question and one for the answer; the engine is never asked to route.
      expect(h.talked.map((request) => request.words)).toEqual(
        expect.arrayContaining([words]),
      );
      expect(h.card("t1")?.state).toBe("running");
      expect(h.sent.map((command) => command.type)).toEqual(["runTask"]);
      expect(h.sent[0]).toMatchObject({
        taskId: "t1",
        brief: { userWords: expect.stringContaining(words) },
      });
      finish(h, "t1", "The answer.");
      expect(h.last().tasks).toEqual([
        expect.objectContaining({
          taskId: "t1",
          state: "done",
          answer: expect.objectContaining({ cardText: "The answer." }),
        }),
      ]);
    },
  );
});
