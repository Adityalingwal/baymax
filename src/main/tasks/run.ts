import type { Findings, TaskId } from "../../shared/cards";
import type { EngineEvent, ParentResult } from "../../shared/engine";
import type { Decision } from "./decision";
import { forgetFailure } from "./failure";
import { appendLine } from "./history";
import { failedLine, stepText } from "./lines";
import type { Admission, Change, Input, Model, TaskRecord } from "./record";
import {
  abandonAttempt,
  dropped,
  dropQuestion,
  hold,
  say,
  sendCancel,
  setTimer,
  silence,
} from "./record";

type RunEvent = Extract<
  EngineEvent,
  { type: "progress" } | { type: "result" } | { type: "failed" }
>;
type Admitted = Extract<Decision, { route: "work" }>;

const LEAVE_MS = 3000;

type Ending = Pick<ParentResult, "outcome" | "findings" | "spokenLine">;

// An admitted task keeps its ask, even when it found nothing; a record that never had one keeps the card's words.
function closeTask(change: Change, record: TaskRecord, ending: Ending): void {
  const { model } = change;
  const { taskId, words } = record.card;
  const ask = record.admission?.ask ?? null;
  model.answers.set(taskId, {
    taskId,
    goal: ask?.goal ?? null,
    words: ask?.userWords ?? words,
    ...ending,
  });
  model.queue = model.queue.filter((id) => id !== taskId);
  dropQuestion(model, record);
  record.sent = null;
  record.attempt = null;
  record.card.state = ending.outcome;
  record.card.step = null;
}

// The result's spoken line is said as the worker wrote it, and joins the conversation history.
function endDone(
  change: Change,
  record: TaskRecord,
  spokenLine: string,
  findings: Findings,
): void {
  closeTask(change, record, { outcome: "done", findings, spokenLine });
  record.spokenLine = spokenLine;
  record.card.spokenLine = spokenLine;
  record.card.answer = findings;
  record.card.line = null;
  const { taskId } = record.card;
  appendLine(change.model.exchanges, taskId, spokenLine);
  say(change, taskId, spokenLine, "answer");
}

// The front call's line was the whole answer: the record is kept for later words and never gets a card.
export function endChat(change: Change, record: TaskRecord, text: string) {
  const findings: Findings = { cardText: text, sources: [] };
  closeTask(change, record, { outcome: "done", findings, spokenLine: text });
  record.spokenLine = text;
  record.card.spokenLine = text;
  record.card.answer = findings;
  record.card.line = null;
}

// It has no line of its own: the talker tells it, in a turn that runs when nothing is in the way.
function endFailed(
  change: Change,
  record: TaskRecord,
  event: Extract<EngineEvent, { type: "failed" }>,
): void {
  const line = failedLine(event.cause, event.reason);
  const { findings } = event;
  closeTask(change, record, { outcome: "failed", findings, spokenLine: null });
  record.card.answer = findings;
  record.card.line = line;
  record.card.canRetry = record.admission !== null;
  record.failedAt = change.model.exchangeOrder;
  change.model.pendingFailures.push({
    taskId: record.card.taskId,
    cause: line,
  });
}

function clearForLeaving(change: Change, record: TaskRecord): void {
  const { card } = record;
  card.answer = null;
  card.canRetry = false;
  if (record.shown) setTimer(change, LEAVE_MS, leave(card.taskId));
}

function endCancelled(
  change: Change,
  record: TaskRecord,
  findings: Findings | null,
): void {
  closeTask(change, record, {
    outcome: "cancelled",
    findings,
    spokenLine: null,
  });
  record.card.line = null;
  clearForLeaving(change, record);
  forgetFailure(change, record.card.taskId);
  silence(change, record.card.taskId);
}

// The record of words that only needed their own line, such as a stop; that line keeps playing.
export function endSpoken(change: Change, record: TaskRecord): void {
  closeTask(change, record, {
    outcome: "cancelled",
    findings: null,
    spokenLine: null,
  });
  record.card.line = null;
  clearForLeaving(change, record);
}

function leave(taskId: TaskId): Input {
  return (change) => {
    const record = change.model.records.get(taskId);
    if (record?.card.state !== "cancelled" || !record.shown) {
      return dropped(change, `leave timer for ${taskId}`);
    }
    record.shown = false;
    return true;
  };
}

function slotBusy(model: Model): boolean {
  for (const record of model.records.values()) {
    if (record.sent?.type === "runTask") return true;
  }
  return false;
}

function canStart(model: Model, record: TaskRecord): boolean {
  const parentId = record.card.parentTaskId;
  return (
    parentId === null ||
    model.answers.has(parentId) ||
    !model.records.has(parentId)
  );
}

function parentResult(change: Change, record: TaskRecord): ParentResult | null {
  const parentId = record.card.parentTaskId;
  if (parentId === null) return null;
  const entry = change.model.answers.get(parentId);
  if (entry !== undefined) return entry;
  change.log(`parent ${parentId} of ${record.card.taskId} is gone`);
  return null;
}

function startTask(
  change: Change,
  record: TaskRecord,
  admission: Admission,
): void {
  const { card } = record;
  const parent = parentResult(change, record);
  if (parent === null) card.parentTaskId = null;
  card.state = "running";
  card.line = null;
  hold(change, record, {
    type: "runTask",
    taskId: card.taskId,
    goalVersion: 1,
    depth: "normal",
    ask: admission.ask,
    parent,
  });
}

function startOrQueue(
  change: Change,
  record: TaskRecord,
  admission: Admission,
): void {
  const { model } = change;
  // Its line is already spoken, so work is never refused: a race past the limit queues one extra.
  if (!slotBusy(model) && canStart(model, record)) {
    startTask(change, record, admission);
  } else {
    record.card.state = "queued";
    model.queue.push(record.card.taskId);
  }
}

// The decision check already kept a follow-up's parent to tasks created before this one.
export function admit(
  change: Change,
  record: TaskRecord,
  decision: Admitted,
): boolean {
  const { card } = record;
  dropQuestion(change.model, record);
  record.shown = true;
  record.admission = { ask: decision.ask };
  record.topic = decision.topic;
  card.title = record.topic;
  card.parentTaskId = decision.parentTaskId;
  card.canRetry = false;
  card.line = null;
  startOrQueue(change, record, record.admission);
  return true;
}

// The one way back in, for a yes and for the card's button: the same task runs again with its saved ask.
export function retryTask(change: Change, taskId: TaskId): boolean {
  const record = change.model.records.get(taskId);
  const admission = record?.admission ?? null;
  if (record === undefined || admission === null || !record.card.canRetry) {
    return dropped(change, `retry ${taskId}`);
  }
  const { card } = record;
  forgetFailure(change, taskId);
  change.model.answers.delete(taskId);
  record.retried = true;
  card.canRetry = false;
  card.line = null;
  card.answer = null;
  card.sourcesRead = 0;
  startOrQueue(change, record, admission);
  return true;
}

// Runs after every accepted change: a queued task may become able to start without the slot freeing.
export function startNext(change: Change): void {
  const { model } = change;
  if (slotBusy(model)) return;
  for (const taskId of model.queue) {
    const record = model.records.get(taskId);
    const admission = record?.admission ?? null;
    if (record === undefined || admission === null) continue;
    if (!canStart(model, record)) continue;
    model.queue = model.queue.filter((id) => id !== taskId);
    startTask(change, record, admission);
    return;
  }
}

export function receiveRunEvent(
  change: Change,
  record: TaskRecord,
  event: RunEvent,
): boolean {
  if (record.card.state !== "running" || record.sent?.type !== "runTask") {
    return dropped(change, `${event.type} for ${record.card.taskId}`);
  }
  switch (event.type) {
    case "progress":
      record.card.step = stepText(event.step);
      record.card.sourcesRead = event.sourcesRead;
      return true;
    case "result":
      endDone(change, record, event.spokenLine, event.findings);
      return true;
    case "failed":
      endFailed(change, record, event);
      return true;
  }
}

// The first reply that ends the engine's step means the work has really stopped.
export function receiveWhileCancelling(
  change: Change,
  record: TaskRecord,
  event: EngineEvent,
): boolean {
  if (event.type === "progress") {
    return dropped(change, `progress while cancelling ${event.taskId}`);
  }
  endCancelled(change, record, event.findings);
  return true;
}

export function receiveUnaskedCancel(
  change: Change,
  record: TaskRecord,
  findings: Findings | null,
): boolean {
  const { state, taskId } = record.card;
  const active =
    state === "thinking" || state === "clarifying" || state === "running";
  if (!active || record.sent === null) {
    return dropped(change, `cancelled for ${taskId} in state ${state}`);
  }
  change.log(`the engine cancelled ${taskId} unasked`);
  endCancelled(change, record, findings);
  return true;
}

export function cancelTask(change: Change, taskId: TaskId): boolean {
  const record = change.model.records.get(taskId);
  if (record === undefined) return dropped(change, `cancel ${taskId}`);
  switch (record.card.state) {
    case "queued":
      endCancelled(change, record, null);
      return true;
    case "thinking":
    case "clarifying":
    case "running":
      // A front call in flight is aborted here, so the card is cancelled at once and no late result can change it.
      if (abandonAttempt(change, record) || record.sent === null) {
        endCancelled(change, record, null);
        return true;
      }
      // Before the send, so a throwing send cannot skip it.
      silence(change, taskId);
      sendCancel(change, record);
      record.card.state = "cancelling";
      record.card.canRetry = false;
      return true;
    default:
      return dropped(change, `cancel ${taskId} in ${record.card.state}`);
  }
}
