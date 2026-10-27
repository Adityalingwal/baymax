import { describe, expect, it } from "vitest";
import type { ClarifyingReply } from "../../shared/cards";
import type { Harness } from "./harness";
import { askClarify, createHarness, finish, intake, newTask } from "./harness";

type AnswerRow = {
  name: string;
  reply: ClarifyingReply;
  answer: (h: Harness, reply: ClarifyingReply) => void;
};

// The intake reads the words as the answer to the waiting question.
function answerRoute(h: Harness, reply: ClarifyingReply): void {
  expect(h.sent.at(-1)).toMatchObject({
    type: "question",
    waiting: { taskId: "t1", question: { questionId: "q1" } },
  });
  h.state.receive(
    intake(h.lastTaskId(), {
      route: "answer",
      waitingTaskId: "t1",
      questionId: "q1",
      reply,
    }),
  );
}

const rows: AnswerRow[] = [
  {
    name: "a click",
    reply: { kind: "choice", index: 1 },
    answer: (h, reply) =>
      h.state.answerQuestion({ taskId: "t1", questionId: "q1", reply }),
  },
  {
    name: "typed words",
    reply: { kind: "text", text: "the cheaper one" },
    answer: (h, reply) => {
      h.state.ask("the cheaper one", null, h.state.waitingQuestion());
      answerRoute(h, reply);
    },
  },
  {
    name: "voice",
    reply: { kind: "choice", index: 2 },
    answer: (h, reply) => {
      const snapshot = h.state.waitingQuestion();
      expect(snapshot?.question.questionId).toBe("q1");
      h.state.ask("the third one", "u1", snapshot);
      answerRoute(h, reply);
    },
  },
];

describe("a clarifying task answered end to end", () => {
  it.each(rows)(
    "continues to done when answered by $name",
    ({ reply, answer }) => {
      const h = createHarness();
      askClarify(h, "q1");
      answer(h, reply);
      expect(h.sent.at(-1)).toMatchObject({
        type: "clarifyingAnswer",
        taskId: "t1",
        question: { questionId: "q1" },
        reply,
      });
      h.state.receive(intake("t1", newTask("about q1")));
      expect(h.card("t1")?.state).toBe("running");
      expect(h.sent.at(-1)).toMatchObject({ type: "runTask", taskId: "t1" });
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
