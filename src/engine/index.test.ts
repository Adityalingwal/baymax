import { describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type {
  EngineCommand,
  EngineEvent,
  RecentExchange,
  WaitingQuestion,
} from "../shared/engine";
import { question, questionReply, startTestEngine } from "./harness";

const words = "how does Hermes agent work inside?";

const brief = {
  goal: "How the Hermes agent works inside",
  resultShape: "A short overview of its parts",
  sources: "Its official docs and repository",
  limits: "Leave out pricing; stop at the main loop",
};

const recent: RecentExchange[] = [
  {
    taskId: "task-0",
    state: "done",
    question: "what is Hermes agent?",
    answer: "Hermes is an open agent.",
  },
];

const waiting: WaitingQuestion = {
  taskId: "task-9",
  question: {
    questionId: "question-1",
    text: "Which laptop do you mean?",
    choices: ["MacBook Air", "MacBook Pro"],
  },
};

const task = {
  sayBack: "how Hermes works inside",
  startLine: "Okay, looking at how Hermes works.",
  brief,
};

const outcome = { ...task, brief: { ...brief, userWords: words } };

const uuid = expect.stringMatching(/^[0-9a-f-]{36}$/);

const clarifyWith = (choices: string[]) =>
  questionReply({
    route: "clarify",
    sayBack: "which laptop to buy",
    clarify: { text: "Which laptop?", choices },
  });

const clarified = (choices: string[]): EngineEvent => ({
  type: "intake",
  taskId: "task-1",
  outcome: {
    route: "clarify",
    sayBack: "which laptop to buy",
    question: { questionId: uuid, text: "Which laptop?", choices },
  },
});

const failed: EngineEvent = {
  type: "failure",
  taskId: "task-1",
  kind: "error",
};

type Row = {
  name: string;
  command: EngineCommand;
  step: ModelOutcome;
  expected: EngineEvent;
};

const rows: Row[] = [
  {
    name: "newTask, strings trimmed",
    command: question(words),
    step: questionReply({ ...task, sayBack: "  how Hermes works inside  " }),
    expected: {
      type: "intake",
      taskId: "task-1",
      outcome: { route: "newTask", ...outcome },
    },
  },
  {
    name: "followUp with a recent parent",
    command: question(words, { recent }),
    step: questionReply({ ...task, route: "followUp", parentTaskId: "task-0" }),
    expected: {
      type: "intake",
      taskId: "task-1",
      outcome: { route: "followUp", parentTaskId: "task-0", ...outcome },
    },
  },
  {
    name: "followUp with an unknown parent becomes newTask",
    command: question(words, { recent }),
    step: questionReply({ ...task, route: "followUp", parentTaskId: "task-7" }),
    expected: {
      type: "intake",
      taskId: "task-1",
      outcome: { route: "newTask", ...outcome },
    },
  },
  {
    name: "answer by choice index",
    command: question("the pro one", { waiting }),
    step: questionReply({
      route: "answer",
      reply: { choiceIndex: 1, text: null },
    }),
    expected: {
      type: "intake",
      taskId: "task-1",
      outcome: {
        route: "answer",
        waitingTaskId: "task-9",
        questionId: "question-1",
        reply: { kind: "choice", index: 1 },
      },
    },
  },
  {
    name: "answer by text",
    command: question("the cheapest one", { waiting }),
    step: questionReply({
      route: "answer",
      reply: { choiceIndex: null, text: "the cheapest one" },
    }),
    expected: {
      type: "intake",
      taskId: "task-1",
      outcome: {
        route: "answer",
        waitingTaskId: "task-9",
        questionId: "question-1",
        reply: { kind: "text", text: "the cheapest one" },
      },
    },
  },
  {
    name: "answer with an out-of-range index and no text",
    command: question("the third", { waiting }),
    step: questionReply({
      route: "answer",
      reply: { choiceIndex: 2, text: null },
    }),
    expected: failed,
  },
  {
    name: "answer without a waiting question",
    command: question("the pro one"),
    step: questionReply({
      route: "answer",
      reply: { choiceIndex: 0, text: null },
    }),
    expected: failed,
  },
  {
    name: "clarify with 2 choices",
    command: question("which one should I buy?"),
    step: clarifyWith(["MacBook Air", "MacBook Pro"]),
    expected: clarified(["MacBook Air", "MacBook Pro"]),
  },
  {
    name: "clarify with 4 choices, the first kept first",
    command: question("which one should I buy?"),
    step: clarifyWith(["Air", "Pro", "Mini", "Studio"]),
    expected: clarified(["Air", "Pro", "Mini", "Studio"]),
  },
  {
    name: "clarify with 1 choice",
    command: question("which one should I buy?"),
    step: clarifyWith(["Air"]),
    expected: failed,
  },
  {
    name: "clarify with 5 choices",
    command: question("which one should I buy?"),
    step: clarifyWith(["A", "B", "C", "D", "E"]),
    expected: failed,
  },
  {
    name: "chat",
    command: question("thanks, that helps"),
    step: questionReply({ route: "chat", sayBack: "  thanks  " }),
    expected: {
      type: "intake",
      taskId: "task-1",
      outcome: { route: "chat", sayBack: "thanks" },
    },
  },
  {
    name: "chat without a say-back",
    command: question("thanks"),
    step: questionReply({ route: "chat", sayBack: " " }),
    expected: failed,
  },
  {
    name: "outsideResearch",
    command: question("email my boss that I'm running late"),
    step: questionReply({ route: "outsideResearch" }),
    expected: {
      type: "intake",
      taskId: "task-1",
      outcome: { route: "outsideResearch" },
    },
  },
];

describe("startEngine question routes", () => {
  it.each(rows)("$name", async (row) => {
    const engine = startTestEngine([row.step]);
    engine.port.send(row.command);
    expect(await engine.settle(1)).toEqual([row.expected]);
    expect(engine.requests).toHaveLength(1);
  });

  it("gives each clarifying question a fresh id", async () => {
    const choices = ["MacBook Air", "MacBook Pro"];
    const engine = startTestEngine([
      clarifyWith(choices),
      clarifyWith(choices),
    ]);
    engine.port.send(question("which one should I buy?"));
    engine.port.send(question("which one?", { taskId: "task-2" }));
    const ids = (await engine.settle(2)).map((event) =>
      event.type === "intake" && event.outcome.route === "clarify"
        ? event.outcome.question.questionId
        : null,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});
