import { describe, expect, it } from "vitest";
import { checkDecision } from "./decision";
import type { DecisionContext } from "./decision";

const waiting = {
  taskId: "t1",
  words: "find me a laptop",
  question: {
    questionId: "q1",
    text: "For what use?",
    choices: ["Office", "Gaming"],
  },
};

const context = (fields: Partial<DecisionContext> = {}): DecisionContext => ({
  words: "the second one",
  waiting: null,
  taskId: "t3",
  // t1 and t2 were created before t3; t0 before t1.
  earlier: (taskId) =>
    new Set({ t3: ["t1", "t2"], t1: ["t0"] }[taskId as "t3" | "t1"] ?? []),
  ...fields,
});

const parts = {
  goal: "g",
  resultShape: "r",
  sources: "s",
  limits: "l",
};

const raw = (fields: Record<string, unknown>) => ({
  route: "chat",
  topic: null,
  parentTaskId: null,
  answerTo: null,
  choices: [],
  brief: null,
  ...fields,
});

type Row = {
  name: string;
  input: unknown;
  context?: Partial<DecisionContext>;
  reason?: string; // set when the check fails
  decision?: object; // set when it passes
};

const rows: Row[] = [
  { name: "no object", input: "chat", reason: "notAnObject" },
  { name: "a list", input: [], reason: "notAnObject" },
  {
    name: "an unknown route",
    input: raw({ route: "answer" }),
    reason: "unknownRoute",
  },
  { name: "a missing route", input: {}, reason: "unknownRoute" },
  { name: "chat", input: raw({}), decision: { route: "chat", answerTo: null } },
  {
    name: "a route in another case",
    input: raw({ route: "OUTSIDERESEARCH" }),
    decision: { route: "outsideResearch", answerTo: null },
  },
  {
    name: "unused fields on chat are ignored",
    input: raw({ topic: 3, brief: "x", choices: "y", parentTaskId: 4 }),
    decision: { route: "chat", answerTo: null },
  },
  {
    name: "a new task without a topic",
    input: raw({ route: "newTask", brief: parts }),
    reason: "missingTopic",
  },
  {
    name: "a new task with a blank topic",
    input: raw({ route: "newTask", topic: " ", brief: parts }),
    reason: "missingTopic",
  },
  {
    name: "a clarify without a topic",
    input: raw({ route: "clarify" }),
    reason: "missingTopic",
  },
  {
    name: "a new task without a brief",
    input: raw({ route: "newTask", topic: "x" }),
    reason: "missingBrief",
  },
  {
    name: "a brief with an empty part",
    input: raw({
      route: "newTask",
      topic: "x",
      brief: { ...parts, limits: " " },
    }),
    reason: "missingBrief",
  },
  {
    name: "a new task",
    input: raw({ route: "newTask", topic: " x ", brief: parts }),
    decision: {
      route: "newTask",
      topic: "x",
      brief: { ...parts, userWords: "the second one" },
      answerTo: null,
    },
  },
  {
    name: "a follow-up whose parent came before",
    input: raw({
      route: "followUp",
      topic: "x",
      brief: parts,
      parentTaskId: "t2",
    }),
    decision: { route: "followUp", parentTaskId: "t2" },
  },
  {
    name: "a follow-up whose parent came later or is unknown, admitted as a new task",
    input: raw({
      route: "followUp",
      topic: "x",
      brief: parts,
      parentTaskId: "t9",
    }),
    decision: { route: "newTask", topic: "x" },
  },
  {
    name: "a follow-up with no parent, admitted as a new task",
    input: raw({ route: "followUp", topic: "x", brief: parts }),
    decision: { route: "newTask", topic: "x" },
  },
  {
    name: "a clarify with no choices",
    input: raw({ route: "clarify", topic: "x" }),
    decision: { route: "clarify", choices: [] },
  },
  {
    name: "a clarify with two choices",
    input: raw({ route: "clarify", topic: "x", choices: ["a", "b"] }),
    decision: { route: "clarify", choices: ["a", "b"] },
  },
  {
    name: "a clarify with four choices",
    input: raw({ route: "clarify", topic: "x", choices: ["a", "b", "c", "d"] }),
    decision: { route: "clarify", choices: ["a", "b", "c", "d"] },
  },
  {
    name: "a clarify with one choice",
    input: raw({ route: "clarify", topic: "x", choices: ["a"] }),
    reason: "badChoices",
  },
  {
    name: "a clarify with five choices",
    input: raw({
      route: "clarify",
      topic: "x",
      choices: ["a", "b", "c", "d", "e"],
    }),
    reason: "badChoices",
  },
  {
    name: "a clarify with a blank choice",
    input: raw({ route: "clarify", topic: "x", choices: ["a", " "] }),
    reason: "badChoices",
  },
  {
    name: "a clarify whose choices are not a list",
    input: raw({ route: "clarify", topic: "x", choices: "a" }),
    reason: "badChoices",
  },
  {
    name: "an answer with nothing waiting",
    input: raw({ answerTo: "q1" }),
    reason: "answerWithoutWaiting",
  },
  {
    name: "an answer that is not an id",
    input: raw({ answerTo: 4 }),
    context: { waiting },
    reason: "badAnswerTo",
  },
  {
    name: "an answer to another question",
    input: raw({ answerTo: "q9" }),
    context: { waiting },
    reason: "answerToWrongQuestion",
  },
  {
    name: "a clarify after an answer",
    input: raw({ route: "clarify", topic: "x", answerTo: "q1" }),
    context: { waiting },
    reason: "clarifyAfterAnswer",
  },
  {
    name: "an answer routed as chat",
    input: raw({ answerTo: "q1" }),
    context: { waiting },
    decision: { route: "chat", answerTo: "q1" },
  },
  {
    name: "an answer routed as a new task joins the original words and the answer",
    input: raw({ route: "newTask", topic: "x", brief: parts, answerTo: "q1" }),
    context: { waiting },
    decision: {
      route: "newTask",
      answerTo: "q1",
      brief: {
        ...parts,
        userWords:
          'find me a laptop\nAnswer to "For what use?": the second one',
      },
    },
  },
  {
    name: "an answer's follow-up checks the parent against the waiting task, not the new card",
    input: raw({
      route: "followUp",
      topic: "x",
      brief: parts,
      parentTaskId: "t2",
      answerTo: "q1",
    }),
    context: { waiting },
    decision: { route: "newTask", topic: "x" },
  },
  {
    name: "an answer's follow-up with a parent older than the waiting task",
    input: raw({
      route: "followUp",
      topic: "x",
      brief: parts,
      parentTaskId: "t0",
      answerTo: "q1",
    }),
    context: { waiting },
    decision: { route: "followUp", parentTaskId: "t0" },
  },
  {
    name: "words that do not answer the waiting question",
    input: raw({ route: "newTask", topic: "x", brief: parts }),
    context: { waiting },
    decision: {
      route: "newTask",
      answerTo: null,
      brief: { ...parts, userWords: "the second one" },
    },
  },
];

describe("the decision check", () => {
  it.each(rows)("$name", ({ input, context: fields, reason, decision }) => {
    const check = checkDecision(input, context(fields));
    if (reason !== undefined) {
      expect(check).toEqual({ ok: false, reason });
    } else {
      expect(check).toMatchObject({ ok: true, decision });
    }
  });

  it("notes a follow-up admitted as a new task", () => {
    const input = raw({
      route: "followUp",
      topic: "x",
      brief: parts,
      parentTaskId: "t9",
    });
    expect(checkDecision(input, context())).toMatchObject({
      ok: true,
      note: "t3 names parent t9; admitted as a new task",
    });
  });
});
