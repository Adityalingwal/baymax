import type { Findings, TaskId } from "../../shared/cards";
import type {
  EngineEvent,
  IntakeOutcome,
  ParentResult,
} from "../../shared/engine";
import { fixedLines, stepText } from "./lines";
import type { Admission, Change, Model, TaskRecord } from "./record";
import {
  dropped,
  endCancelled,
  endDone,
  endIncomplete,
  hold,
  say,
  sendCancel,
} from "./record";

const QUEUE_LIMIT = 3;

type RunEvent = Extract<
  EngineEvent,
  { type: "progress" } | { type: "result" } | { type: "incomplete" }
>;
type AdmittedOutcome = Extract<IntakeOutcome, { route: "newTask" }>;

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
  const { taskId } = record.card;
  record.card.state = "running";
  record.card.line = admission.startLine;
  hold(change, record, {
    type: "runTask",
    taskId,
    goalVersion: 1,
    depth: "normal",
    brief: admission.brief,
    parent: parentResult(change, record),
  });
}

export function admit(
  change: Change,
  record: TaskRecord,
  outcome: AdmittedOutcome,
): boolean {
  const { model } = change;
  const { card } = record;
  const admission = { startLine: outcome.startLine, brief: outcome.brief };
  record.admission = admission;
  card.sayBack = outcome.sayBack;
  card.question = null;
  card.canRetry = false;
  if (!slotBusy(model) && canStart(model, record)) {
    startTask(change, record, admission);
    say(change, card.taskId, admission.startLine, "startLine");
  } else if (model.queue.length < QUEUE_LIMIT) {
    card.state = "queued";
    card.line = fixedLines.queued;
    model.queue.push(card.taskId);
    say(change, card.taskId, fixedLines.queued, "startLine");
  } else {
    endCancelled(change, record, null, fixedLines.queueFull);
  }
  return true;
}

// Runs after every accepted change: a queued task may become able to start without the slot freeing.
export function startNext(change: Change): void {
  const { model } = change;
  if (slotBusy(model)) return;
  for (const taskId of model.queue) {
    const record = model.records.get(taskId);
    if (record?.admission == null || !canStart(model, record)) continue;
    model.queue = model.queue.filter((id) => id !== taskId);
    startTask(change, record, record.admission);
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
    case "incomplete":
      endIncomplete(change, record, event.incomplete);
      return true;
  }
}

function carriedFindings(event: EngineEvent): Findings | null {
  switch (event.type) {
    case "cancelled":
    case "result":
      return event.findings;
    case "incomplete":
      return event.incomplete.findings;
    default:
      return null;
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
  endCancelled(change, record, carriedFindings(event), null);
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
  endCancelled(change, record, findings, null);
  return true;
}

export function cancelTask(change: Change, taskId: TaskId): boolean {
  const record = change.model.records.get(taskId);
  if (record === undefined) return dropped(change, `cancel ${taskId}`);
  switch (record.card.state) {
    case "queued":
      endCancelled(change, record, null, null);
      return true;
    case "thinking":
    case "clarifying":
    case "running":
      if (record.sent === null) {
        endCancelled(change, record, null, null);
        return true;
      }
      sendCancel(change, record);
      record.card.state = "cancelling";
      record.card.canRetry = false;
      record.letMeCheckDue = false;
      return true;
    default:
      return dropped(change, `cancel ${taskId} in ${record.card.state}`);
  }
}
