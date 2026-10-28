import type { QuestionId, TaskId } from "../../shared/cards";
import type { WorkerBrief } from "../../shared/engine";
import type { WaitingQuestion } from "./talk";

type Route =
  | { route: "chat" | "outsideResearch" }
  | { route: "clarify"; topic: string; choices: string[] }
  | { route: "newTask"; topic: string; brief: WorkerBrief }
  | {
      route: "followUp";
      topic: string;
      brief: WorkerBrief;
      parentTaskId: TaskId;
    };

// The front call's decision after the checks; answerTo is the waiting question it answers.
export type Decision = Route & { answerTo: QuestionId | null };

export type DecisionContext = {
  words: string;
  waiting: WaitingQuestion | null; // the question shown when the words were asked
  earlier: (taskId: TaskId) => ReadonlySet<TaskId>; // tasks created before the given task
  taskId: TaskId; // the task the words were asked as
};

export type DecisionCheck =
  | { ok: true; decision: Decision; note: string | null }
  | { ok: false; reason: string };

type Fields = Record<string, unknown>;

const routes = [
  "chat",
  "clarify",
  "newTask",
  "followUp",
  "outsideResearch",
] as const;

const fail = (reason: string): DecisionCheck => ({ ok: false, reason });

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filled(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readRoute(value: unknown): (typeof routes)[number] | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return routes.find((route) => route.toLowerCase() === lower) ?? null;
}

function readParts(value: unknown): Omit<WorkerBrief, "userWords"> | null {
  if (!isFields(value)) return null;
  const goal = filled(value.goal);
  const resultShape = filled(value.resultShape);
  const sources = filled(value.sources);
  const limits = filled(value.limits);
  if (!goal || !resultShape || !sources || !limits) return null;
  return { goal, resultShape, sources, limits };
}

// Zero choices is an open question; otherwise two to four.
function readChoices(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 1 || value.length > 4) return null;
  const choices: string[] = [];
  for (const item of value) {
    const choice = filled(item);
    if (choice === null) return null;
    choices.push(choice);
  }
  return choices;
}

// The brief carries the words as the user said them; an answer adds the question and the reply.
function userWordsFor(context: DecisionContext, answered: boolean): string {
  const { waiting, words } = context;
  if (!answered || waiting === null) return words;
  return `${waiting.words}\nAnswer to "${waiting.question.text}": ${words}`;
}

type AnswerCheck =
  { ok: true; answerTo: QuestionId | null } | { ok: false; reason: string };

function readAnswerTo(
  raw: Fields,
  route: (typeof routes)[number],
  waiting: WaitingQuestion | null,
): AnswerCheck {
  const value = raw.answerTo ?? null;
  if (value === null) return { ok: true, answerTo: null };
  if (typeof value !== "string") return { ok: false, reason: "badAnswerTo" };
  if (waiting === null) return { ok: false, reason: "answerWithoutWaiting" };
  if (value !== waiting.question.questionId) {
    return { ok: false, reason: "answerToWrongQuestion" };
  }
  if (route === "clarify") return { ok: false, reason: "clarifyAfterAnswer" };
  return { ok: true, answerTo: value };
}

// Checks the decide tool's raw input before main starts, binds or ends anything; no model is asked.
export function checkDecision(
  raw: unknown,
  context: DecisionContext,
): DecisionCheck {
  if (!isFields(raw)) return fail("notAnObject");
  const route = readRoute(raw.route);
  if (route === null) return fail("unknownRoute");
  const answer = readAnswerTo(raw, route, context.waiting);
  if (!answer.ok) return fail(answer.reason);
  const { answerTo } = answer;
  if (route === "chat" || route === "outsideResearch") {
    return { ok: true, decision: { route, answerTo }, note: null };
  }
  const topic = filled(raw.topic);
  if (topic === null) return fail("missingTopic");
  if (route === "clarify") {
    const choices = readChoices(raw.choices);
    if (choices === null) return fail("badChoices");
    return {
      ok: true,
      decision: { route, topic, choices, answerTo },
      note: null,
    };
  }
  const parts = readParts(raw.brief);
  if (parts === null) return fail("missingBrief");
  const brief = {
    ...parts,
    userWords: userWordsFor(context, answerTo !== null),
  };
  if (route === "newTask") {
    return {
      ok: true,
      decision: { route, topic, brief, answerTo },
      note: null,
    };
  }
  const target =
    answerTo !== null && context.waiting
      ? context.waiting.taskId
      : context.taskId;
  const parentTaskId = filled(raw.parentTaskId);
  if (parentTaskId !== null && context.earlier(target).has(parentTaskId)) {
    const decision: Decision = { route, topic, brief, parentTaskId, answerTo };
    return { ok: true, decision, note: null };
  }
  const note = `${target} names parent ${String(raw.parentTaskId)}; admitted as a new task`;
  const decision: Decision = { route: "newTask", topic, brief, answerTo };
  return { ok: true, decision, note };
}
