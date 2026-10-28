import type { Findings, TaskId } from "../../shared/cards";
import type { Incomplete, ParentResult } from "../../shared/engine";
import { appendResult } from "./history";
import { fixedLines, incompleteLines } from "./lines";
import type { Change, Input, TaskRecord } from "./record";
import { dropped, say, setTimer, silence } from "./record";

const LEAVE_MS = 3000;

function closeTask(
  change: Change,
  record: TaskRecord,
  outcome: ParentResult["outcome"],
  findings: Findings | null,
): void {
  const { model } = change;
  const { taskId } = record.card;
  model.answers.set(taskId, { taskId, outcome, findings });
  model.queue = model.queue.filter((id) => id !== taskId);
  model.questions = model.questions.filter((id) => id !== taskId);
  record.sent = null;
  record.attempt = null;
  record.failedAttempt = null;
  record.hiddenQuestion = null;
  record.card.state = outcome;
  record.card.step = null;
}

// The result's spoken line is said as the worker wrote it, and joins the conversation history.
export function endDone(
  change: Change,
  record: TaskRecord,
  spokenLine: string,
  findings: Findings,
): void {
  closeTask(change, record, "done", findings);
  record.spokenLine = spokenLine;
  record.card.answer = findings;
  record.card.line = record.builtOnPartial ? fixedLines.builtOnPartial : null;
  const { taskId } = record.card;
  appendResult(change.model.exchanges, taskId, spokenLine);
  say(change, taskId, spokenLine, "answer");
}

// The front call's line was the whole answer, so the card shows it as a done answer.
export function endChat(change: Change, record: TaskRecord, text: string) {
  const findings: Findings = { cardText: text, sources: [], openPoints: [] };
  closeTask(change, record, "done", findings);
  record.spokenLine = text;
  record.card.reply = text;
  record.card.question = null;
  record.card.answer = findings;
  record.card.line = null;
}

export function endIncomplete(
  change: Change,
  record: TaskRecord,
  incomplete: Incomplete,
): void {
  const lines = incompleteLines(incomplete, record.topic);
  closeTask(change, record, "incomplete", incomplete.findings);
  record.card.answer = incomplete.findings;
  record.card.line = lines.line;
  record.card.missing = lines.missing;
  // The worker's next question is model text, said as given; fixed lines are said as written.
  const kind = incomplete.kind === "needsUser" ? "answer" : "failure";
  say(change, record.card.taskId, lines.spoken, kind);
}

function clearForLeaving(change: Change, record: TaskRecord): void {
  const { card } = record;
  card.question = null;
  card.answer = null;
  card.missing = null;
  card.canRetry = false;
  setTimer(change, LEAVE_MS, leave(card.taskId));
}

export function endCancelled(
  change: Change,
  record: TaskRecord,
  findings: Findings | null,
  line: string | null,
): void {
  closeTask(change, record, "cancelled", findings);
  record.card.line = line;
  clearForLeaving(change, record);
  const { taskId } = record.card;
  if (line === null) silence(change, taskId);
  else say(change, taskId, line, "failure");
}

// A request to act outside research: the front call's own line, already said, is the card's reply.
export function endOutside(
  change: Change,
  record: TaskRecord,
  spoken: string,
): void {
  closeTask(change, record, "cancelled", null);
  record.card.line = null;
  record.card.reply = spoken;
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
