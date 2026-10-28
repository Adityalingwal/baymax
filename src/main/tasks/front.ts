import type { QuestionId, TaskId } from "../../shared/cards";
import type { FailureKind } from "../../shared/engine";
import { checkDecision } from "./decision";
import { addExchange } from "./history";
import { failureLine } from "./lines";
import type { Attempt, Change, FrontParts, Model, TaskRecord } from "./record";
import { dropped, say, talk } from "./record";
import { applyDecision } from "./route";
import type { TalkerReply } from "./talk";

// Starts one front call for the record; its id is unique, so a late result of an older call is told apart.
export function openAttempt(
  change: Change,
  record: TaskRecord,
  parts: FrontParts,
  submitted: QuestionId | null,
): void {
  record.attempts += 1;
  change.model.exchangeOrder += 1;
  const id = `${record.card.taskId}#${record.attempts}`;
  const order = change.model.exchangeOrder;
  record.attempt = { id, order, parts, submitted };
  talk(change, { kind: "front", attemptId: id, ...parts });
}

// Tasks created before the given one: a follow-up names a parent only from these.
function earlierThan(model: Model, taskId: TaskId): ReadonlySet<TaskId> {
  const created = model.records.get(taskId)?.created ?? 0;
  const ids = [...model.records.values()]
    .filter((record) => record.created < created)
    .map((record) => record.card.taskId);
  return new Set(ids);
}

// A card answer names the question it answers even when the tool call leaves it out.
function withSubmitted(raw: unknown, submitted: QuestionId | null): unknown {
  if (submitted === null) return raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const given = "answerTo" in raw ? raw.answerTo : null;
  return { ...raw, answerTo: given ?? submitted };
}

function failFront(
  change: Change,
  record: TaskRecord,
  attempt: Attempt,
  kind: FailureKind,
): boolean {
  record.failedAttempt = attempt;
  const line = failureLine(kind);
  record.card.line = line;
  record.card.canRetry = true;
  say(change, record.card.taskId, line, "failure");
  return true;
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
  addExchange(change.model.exchanges, {
    order: attempt.order,
    taskId,
    words: attempt.parts.words,
    line: reply.text ?? "",
  });
  if (reply.kind === "failed") {
    return failFront(change, record, attempt, reply.failure);
  }
  const context = {
    words: attempt.parts.words,
    waiting: attempt.parts.waiting,
    taskId,
    earlier: (id: TaskId) => earlierThan(change.model, id),
  };
  const raw = withSubmitted(reply.decision, attempt.submitted);
  const check = checkDecision(raw, context);
  if (!check.ok) {
    change.log(`decision rejected for ${taskId}: ${check.reason}`);
    return failFront(change, record, attempt, "error");
  }
  if (check.note !== null) change.log(check.note);
  return applyDecision(change, record, attempt, check.decision, reply.text);
}

export function retryTask(change: Change, taskId: TaskId): boolean {
  const record = change.model.records.get(taskId);
  const state = record?.card.state;
  const failed = record?.failedAttempt ?? null;
  if (
    record === undefined ||
    (state !== "thinking" && state !== "clarifying") ||
    !record.card.canRetry ||
    failed === null ||
    record.attempt !== null
  ) {
    return dropped(change, `retry ${taskId}`);
  }
  record.card.canRetry = false;
  record.card.line = null;
  record.failedAttempt = null;
  openAttempt(change, record, failed.parts, failed.submitted);
  return true;
}
