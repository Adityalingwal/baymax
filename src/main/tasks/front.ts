import type { TaskId } from "../../shared/cards";
import type { FailureKind } from "../../shared/engine";
import { checkDecision } from "./decision";
import type { Decision } from "./decision";
import { addExchange, setExchangeTask } from "./history";
import { frontFailureLine } from "./lines";
import type { Attempt, Change, FrontParts, Model, TaskRecord } from "./record";
import {
  activeQuestion,
  addChat,
  dropped,
  holdQuestion,
  nextAttemptId,
  say,
  talk,
} from "./record";
import { admit, cancelTask, endChat, endSpoken, retryTask } from "./run";
import type { QuestionId, TalkerReply } from "./talk";

// Starts one front call for the record; its id is unique, so a late result of an older call is told apart.
export function openAttempt(
  change: Change,
  record: TaskRecord,
  parts: FrontParts,
): void {
  const id = nextAttemptId(record);
  change.model.exchangeOrder += 1;
  const order = change.model.exchangeOrder;
  record.attempt = { id, order, parts };
  talk(change, { kind: "front", attemptId: id, ...parts });
}

// Tasks created before the given one: work names a parent only from these.
function earlierThan(model: Model, taskId: TaskId): ReadonlySet<TaskId> {
  const created = model.records.get(taskId)?.created ?? 0;
  const ids = [...model.records.values()]
    .filter((record) => record.created < created)
    .map((record) => record.card.taskId);
  return new Set(ids);
}

function canStop(model: Model, taskId: TaskId): boolean {
  const state = model.records.get(taskId)?.card.state;
  return state === "running" || state === "queued" || state === "clarifying";
}

// A task that can still say more keeps its exchange, so the later line has somewhere to go.
function canSayMore(model: Model, taskId: TaskId): boolean {
  const state = model.records.get(taskId)?.card.state;
  return state === "queued" || state === "running" || state === "failed";
}

function canRetry(model: Model, taskId: TaskId): boolean {
  return model.records.get(taskId)?.card.canRetry === true;
}

function addChatTurn(change: Change, words: string, line: string): void {
  addChat(change, "user", words);
  addChat(change, "baymax", line);
}

// Nothing shows and nothing is kept: the record goes, and work that named it as a parent runs without one.
function failFront(
  change: Change,
  record: TaskRecord,
  attempt: Attempt,
  failure: { kind: FailureKind; spoke: boolean },
): boolean {
  const { taskId } = record.card;
  change.model.records.delete(taskId);
  const line = frontFailureLine(failure.kind, failure.spoke);
  addChatTurn(change, attempt.parts.words, line);
  say(change, taskId, line, "failure");
  return true;
}

// The record the words answer, if its question is still the active one; a call's waiting question was only context.
function claimTarget(change: Change, answerTo: QuestionId): TaskRecord | null {
  const target = activeQuestion(change.model);
  return target?.question?.questionId === answerTo ? target : null;
}

// The record the decision is for: the record of the words, or the waiting one they answer; null when the answer is stale.
function resolveTarget(
  change: Change,
  record: TaskRecord,
  decision: Decision,
): TaskRecord | null {
  if (decision.answerTo === null) return record;
  // Words that answer a question are not a task of their own.
  change.model.records.delete(record.card.taskId);
  const target = claimTarget(change, decision.answerTo);
  if (target === null) {
    change.log(
      `answer ${decision.answerTo} for ${record.card.taskId} is stale`,
    );
  }
  return target;
}

// Applies a checked decision. The spoken line is already out, so even a stale answer's line joins the Chat list.
function applyDecision(
  change: Change,
  record: TaskRecord,
  attempt: Attempt,
  decision: Decision,
  line: string,
): boolean {
  if (decision.route === "stop") {
    cancelTask(change, decision.taskId);
    endSpoken(change, record);
    return true;
  }
  if (decision.route === "retry") {
    addChatTurn(change, attempt.parts.words, line);
    setExchangeTask(change.model.exchanges, attempt.order, decision.taskId);
    retryTask(change, decision.taskId);
    endSpoken(change, record);
    return true;
  }
  if (decision.route !== "work" || decision.answerTo !== null) {
    addChatTurn(change, attempt.parts.words, line);
  }
  const target = resolveTarget(change, record, decision);
  if (target === null) return true;
  setExchangeTask(change.model.exchanges, attempt.order, target.card.taskId);
  switch (decision.route) {
    case "reply":
      endChat(change, target, line);
      return true;
    case "ask":
      target.topic = decision.topic;
      target.card.title = decision.topic;
      target.card.state = "clarifying";
      holdQuestion(change, target, line, attempt.order);
      return true;
    case "work":
      return admit(change, target, decision);
  }
}

// The one terminal result of an attempt; a result for an attempt that is not the record's current one changes nothing.
export function receiveFront(
  change: Change,
  taskId: TaskId,
  attemptId: string,
  reply: TalkerReply,
): boolean {
  const record = change.model.records.get(taskId);
  const attempt = record?.attempt ?? null;
  if (record === undefined || attempt === null || attempt.id !== attemptId) {
    return dropped(change, `front call ${attemptId} for ${taskId}`);
  }
  record.attempt = null;
  // What was spoken is part of the conversation whether or not the decision holds.
  addExchange(
    change.model.exchanges,
    {
      order: attempt.order,
      taskId,
      words: attempt.parts.words,
      line: reply.text ?? "",
    },
    (id) => canSayMore(change.model, id),
  );
  if (reply.kind === "failed") {
    const spoke = (reply.text ?? "").trim() !== "";
    return failFront(change, record, attempt, { kind: reply.failure, spoke });
  }
  const context = {
    words: attempt.parts.words,
    waiting: attempt.parts.waiting,
    taskId,
    earlier: (id: TaskId) => earlierThan(change.model, id),
    canStop: (id: TaskId) => canStop(change.model, id),
    canRetry: (id: TaskId) => canRetry(change.model, id),
  };
  const check = checkDecision(reply.decision, context);
  if (!check.ok) {
    change.log(`decision rejected for ${taskId}: ${check.reason}`);
    return failFront(change, record, attempt, { kind: "error", spoke: true });
  }
  if (check.note !== null) change.log(check.note);
  return applyDecision(change, record, attempt, check.decision, reply.text);
}
