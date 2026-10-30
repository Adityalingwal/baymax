import type { TaskId } from "../../shared/cards";
import { recentExchanges, roomLeft, taskSummaries } from "./display";
import { appendLine, conversationHistory } from "./history";
import type { Change, FailureCall, Model, TaskRecord } from "./record";
import { addChat, nextAttemptId, say, talk } from "./record";
import type { TalkerReply } from "./talk";

function frontCallInFlight(model: Model): boolean {
  return [...model.records.values()].some(({ attempt }) => attempt !== null);
}

function failureMayStart(model: Model): boolean {
  return (
    model.pendingFailures.length > 0 &&
    model.failureCall === null &&
    model.voiceIdle &&
    model.questions.length === 0 &&
    !frontCallInFlight(model)
  );
}

// Voice going idle wakes a waiting turn; otherwise nothing shown changed, so nothing is published.
export function setVoiceIdle(change: Change, idle: boolean): boolean {
  change.model.voiceIdle = idle;
  return failureMayStart(change.model);
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

// The decision is read for nothing: whatever route came back, the task stays failed. With no model to speak, the cause is said as written.
export function receiveFailureTurn(
  change: Change,
  { taskId, cause }: FailureCall,
  reply: TalkerReply,
): boolean {
  const { model } = change;
  model.failureCall = null;
  const record = model.records.get(taskId);
  if (record === undefined) return true;
  const said = reply.text ?? "";
  appendLine(model, record.card, said);
  if (reply.kind === "failed") {
    appendLine(model, record.card, cause);
    // What was spoken stays on the screen, even from a call that then failed.
    if (said !== "") addChat(change, "baymax", said);
    addChat(change, "baymax", cause);
    say(change, taskId, cause, "failure");
    return true;
  }
  addChat(change, "baymax", said);
  if (!record.retried) openOffer(model, record);
  return true;
}

// The task is running again or gone, so nothing may still tell its failure; its later lines still speak.
export function forgetFailure(change: Change, taskId: TaskId): void {
  const { model, outputs } = change;
  const other = (entry: { taskId: TaskId }) => entry.taskId !== taskId;
  model.pendingFailures = model.pendingFailures.filter(other);
  model.offers = model.offers.filter(other);
  if (model.failureCall?.taskId === taskId) {
    outputs.push({
      kind: "cancelAttempt",
      attemptId: model.failureCall.attemptId,
    });
    model.failureCall = null;
  }
  outputs.push({ kind: "cutFailure", taskId });
}
