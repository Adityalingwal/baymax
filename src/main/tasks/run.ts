import type { Findings, TaskId } from "../../shared/cards";
import type {
  EngineEvent,
  IntakeOutcome,
  ParentResult,
} from "../../shared/engine";
import { fixedLines, partialParentLine, stepText } from "./lines";
import type { Admission, Change, Model, TaskRecord } from "./record";
import {
  dropped,
  endCancelled,
  endDone,
  endIncomplete,
  hold,
  sendCancel,
  silence,
} from "./record";

const QUEUE_LIMIT = 3;

type RunEvent = Extract<
  EngineEvent,
  { type: "progress" } | { type: "result" } | { type: "incomplete" }
>;
type AdmittedOutcome = Extract<
  IntakeOutcome,
  { route: "newTask" } | { route: "followUp" }
>;

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

// The card's line is the fixed partial-parent line when the parent did not end done, else the model's start line.
function startTask(
  change: Change,
  record: TaskRecord,
  admission: Admission,
): void {
  const { card } = record;
  const parent = parentResult(change, record);
  const parentId = card.parentTaskId;
  const parentSayBack =
    parentId === null
      ? null
      : (change.model.records.get(parentId)?.card.sayBack ?? null);
  const partial =
    parent === null ? null : partialParentLine(parent, parentSayBack);
  if (parent === null) card.parentTaskId = null;
  record.builtOnPartial = partial !== null && parent?.findings !== null;
  card.state = "running";
  card.line = partial ?? admission.startLine;
  hold(change, record, {
    type: "runTask",
    taskId: card.taskId,
    goalVersion: 1,
    depth: "normal",
    brief: admission.brief,
    parent,
  });
}

// A parent created after the follow-up would let two thinking tasks name each other.
function validParent(
  change: Change,
  record: TaskRecord,
  outcome: AdmittedOutcome,
): TaskId | null {
  if (outcome.route !== "followUp") return null;
  const parent = change.model.records.get(outcome.parentTaskId);
  if (parent !== undefined && parent.created < record.created) {
    return outcome.parentTaskId;
  }
  change.log(
    `${record.card.taskId} names parent ${outcome.parentTaskId}; admitted as a new task`,
  );
  return null;
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
  card.parentTaskId = validParent(change, record, outcome);
  card.question = null;
  card.canRetry = false;
  // The start line and the queued line show on the card only; the talker is the voice.
  if (!slotBusy(model) && canStart(model, record)) {
    startTask(change, record, admission);
  } else if (model.queue.length < QUEUE_LIMIT) {
    card.state = "queued";
    card.line = fixedLines.queued;
    model.queue.push(card.taskId);
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
