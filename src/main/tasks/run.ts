import type { Findings, TaskId } from "../../shared/cards";
import type { EngineEvent, ParentResult } from "../../shared/engine";
import type { Decision } from "./decision";
import { endCancelled, endDone, endIncomplete } from "./end";
import { fixedLines, partialParentLine, stepText } from "./lines";
import type { Admission, Change, Model, TaskRecord } from "./record";
import { abandonAttempt, dropped, hold, sendCancel, silence } from "./record";

const QUEUE_LIMIT = 3;

type RunEvent = Extract<
  EngineEvent,
  { type: "progress" } | { type: "result" } | { type: "incomplete" }
>;
type Admitted = Extract<Decision, { route: "newTask" | "followUp" }>;

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

// The card's line is the fixed partial-parent line when the parent did not end done, else none.
function startTask(
  change: Change,
  record: TaskRecord,
  admission: Admission,
): void {
  const { card } = record;
  const parent = parentResult(change, record);
  const parentId = card.parentTaskId;
  const parentTopic =
    parentId === null
      ? null
      : (change.model.records.get(parentId)?.topic ?? null);
  const partial =
    parent === null ? null : partialParentLine(parent, parentTopic);
  if (parent === null) card.parentTaskId = null;
  record.builtOnPartial = partial !== null && parent?.findings !== null;
  card.state = "running";
  card.line = partial;
  hold(change, record, {
    type: "runTask",
    taskId: card.taskId,
    goalVersion: 1,
    depth: "normal",
    brief: admission.brief,
    parent,
  });
}

// The decision check already kept a follow-up's parent to tasks created before this one.
export function admit(
  change: Change,
  record: TaskRecord,
  decision: Admitted,
  line: string,
): boolean {
  const { model } = change;
  const { card } = record;
  record.admission = { brief: decision.brief };
  record.topic = decision.topic;
  card.sayBack = null;
  card.reply = line;
  card.parentTaskId =
    decision.route === "followUp" ? decision.parentTaskId : null;
  card.question = null;
  card.canRetry = false;
  card.line = null;
  // The spoken line shows on the card; the queued line is fixed and shown only.
  if (!slotBusy(model) && canStart(model, record)) {
    startTask(change, record, record.admission);
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
      // A front call in flight is aborted here, so the card is cancelled at once and no late result can change it.
      if (abandonAttempt(change, record) || record.sent === null) {
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
