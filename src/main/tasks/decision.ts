import type { TaskId } from "../../shared/cards";
import type { TaskAsk } from "../../shared/engine";
import type { QuestionId, WaitingQuestion } from "./talk";

type Route =
  | { route: "reply" }
  | { route: "ask"; topic: string | null }
  | { route: "work"; topic: string; ask: TaskAsk; parentTaskId: TaskId | null }
  | { route: "stop"; taskId: TaskId }
  | { route: "retry"; taskId: TaskId };

// The front call's decision after the checks; answerTo is the waiting question it answers.
export type Decision = Route & { answerTo: QuestionId | null };

export type DecisionContext = {
  words: string;
  waiting: WaitingQuestion | null; // the question active when the words were asked
  earlier: (taskId: TaskId) => ReadonlySet<TaskId>; // tasks created before the given task
  taskId: TaskId; // the task the words were asked as
  canStop: (taskId: TaskId) => boolean; // the task is running, queued or holding a waiting question
  canRetry: (taskId: TaskId) => boolean; // the task is failed and was admitted
};

export type DecisionCheck =
  | { ok: true; decision: Decision; note: string | null }
  | { ok: false; reason: string };

type Fields = Record<string, unknown>;

const routes = ["reply", "ask", "work", "stop", "retry"] as const;

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
  return routes.find((route) => route === lower) ?? null;
}

// The ask carries the words as the user said them; an answer adds the question and the reply.
function userWordsFor(context: DecisionContext, answered: boolean): string {
  const { waiting, words } = context;
  if (!answered || waiting === null) return words;
  return `${waiting.words}\nAnswer to "${waiting.question.text}": ${words}`;
}

type AnswerCheck =
  { ok: true; answerTo: QuestionId | null } | { ok: false; reason: string };

function readAnswerTo(
  raw: Fields,
  route: "reply" | "ask" | "work",
  waiting: WaitingQuestion | null,
): AnswerCheck {
  const value = raw.answerTo ?? null;
  if (value === null) return { ok: true, answerTo: null };
  if (typeof value !== "string") return { ok: false, reason: "badAnswerTo" };
  if (waiting === null) return { ok: false, reason: "answerWithoutWaiting" };
  if (value !== waiting.question.questionId) {
    return { ok: false, reason: "answerToWrongQuestion" };
  }
  if (route === "ask") return { ok: false, reason: "askAfterAnswer" };
  return { ok: true, answerTo: value };
}

function checkWork(
  raw: Fields,
  context: DecisionContext,
  answerTo: QuestionId | null,
): DecisionCheck {
  const topic = filled(raw.topic);
  if (topic === null) return fail("missingTopic");
  const goal = filled(raw.goal);
  if (goal === null) return fail("missingGoal");
  const ask = { goal, userWords: userWordsFor(context, answerTo !== null) };
  const work = (parentTaskId: TaskId | null): Decision => ({
    route: "work",
    topic,
    ask,
    parentTaskId,
    answerTo,
  });
  const named = filled(raw.taskId);
  if (named === null) return { ok: true, decision: work(null), note: null };
  const target =
    answerTo !== null && context.waiting
      ? context.waiting.taskId
      : context.taskId;
  if (context.earlier(target).has(named)) {
    return { ok: true, decision: work(named), note: null };
  }
  const note = `${target} names parent ${named}; admitted as a new task`;
  return { ok: true, decision: work(null), note };
}

// Words that drop a question may also name it as answered; what is stopped is the task, so answerTo is not read.
function checkStop(raw: Fields, context: DecisionContext): DecisionCheck {
  const taskId = filled(raw.taskId);
  if (taskId === null) return fail("missingTaskId");
  if (!context.canStop(taskId)) return fail("cannotStop");
  return {
    ok: true,
    decision: { route: "stop", taskId, answerTo: null },
    note: null,
  };
}

// A yes to an offer is not an answer to a question; a task no longer failed makes the yes stale, so nothing starts.
function checkRetry(raw: Fields, context: DecisionContext): DecisionCheck {
  const taskId = filled(raw.taskId);
  if (taskId === null) return fail("missingTaskId");
  if ((raw.answerTo ?? null) !== null) return fail("answerOnRetry");
  if (!context.canRetry(taskId)) return fail("cannotRetry");
  return {
    ok: true,
    decision: { route: "retry", taskId, answerTo: null },
    note: null,
  };
}

// Checks the decide tool's raw input before main starts, binds or ends anything; no model is asked.
export function checkDecision(
  raw: unknown,
  context: DecisionContext,
): DecisionCheck {
  if (!isFields(raw)) return fail("notAnObject");
  const route = readRoute(raw.route);
  if (route === null) return fail("unknownRoute");
  if (route === "retry") return checkRetry(raw, context);
  if (route === "stop") return checkStop(raw, context);
  const answer = readAnswerTo(raw, route, context.waiting);
  if (!answer.ok) return fail(answer.reason);
  const { answerTo } = answer;
  if (route === "work") return checkWork(raw, context, answerTo);
  const decision: Decision =
    route === "ask"
      ? { route, topic: filled(raw.topic), answerTo }
      : { route, answerTo };
  return { ok: true, decision, note: null };
}
