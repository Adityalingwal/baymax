import type { TaskId } from "../../shared/cards";
import { recentExchanges, roomLeft, taskSummaries } from "./display";
import { appendLine, conversationHistory } from "./history";
import type { Change, FailureCall, Model, TaskRecord } from "./record";
import { addChat, nextAttemptId, talk } from "./record";
import type { TalkerReply } from "./talk";

function failureMayStart(model: Model): boolean {
  return model.pendingFailures.length > 0 && model.failureCall === null;
}

function titleOf({ topic, card }: TaskRecord): string {
  return topic ?? card.words;
}

// Runs after every accepted change: the next failed task, if nothing is in the way, gets its own talker call.
export function startFailureTurn(change: Change): void {
  const { model } = change;
  if (!failureMayStart(model)) return;
  const pending = model.pendingFailures.shift();
  const record = pending && model.records.get(pending.taskId);
  if (pending === undefined || record === undefined) return;
  const { taskId, cause } = pending;
  const attemptId = nextAttemptId(record);
  model.failureCall = { attemptId, taskId, cause };
  talk(change, {
    kind: "failure",
    attemptId,
    taskId,
    failed: {
      title: titleOf(record),
      cause,
      onScreen: record.card.answer === null ? "nothing" : "the pages it read",
      triedAgain: record.retried,
    },
    history: conversationHistory(model.exchanges),
    recent: recentExchanges(model, taskId),
    offers: [],
    tasks: taskSummaries(model),
    room: roomLeft(model),
    waiting: null,
  });
}

function openOffer(model: Model, record: TaskRecord): void {
  model.offersMade += 1;
  model.offers.push({
    taskId: record.card.taskId,
    title: titleOf(record),
    order: model.offersMade,
  });
}

// The decision is read for nothing: whatever route came back, the task stays failed.
export function receiveFailureTurn(
  change: Change,
  { taskId }: FailureCall,
  reply: TalkerReply,
): boolean {
  const { model } = change;
  model.failureCall = null;
  const record = model.records.get(taskId);
  if (reply.kind === "failed" || record === undefined) return true;
  appendLine(model.exchanges, taskId, reply.text);
  addChat(change, "baymax", reply.text);
  if (!record.retried) openOffer(model, record);
  return true;
}

// The task is running again or gone, so what was waiting to tell its failure no longer holds.
export function forgetFailure(change: Change, taskId: TaskId): void {
  const { model } = change;
  const other = (entry: { taskId: TaskId }) => entry.taskId !== taskId;
  model.pendingFailures = model.pendingFailures.filter(other);
  model.offers = model.offers.filter(other);
}
