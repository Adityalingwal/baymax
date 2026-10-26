import type { TaskId, UtteranceId } from "../../shared/cards";
import type {
  FailureKind,
  IntakeOutcome,
  WaitingQuestion,
} from "../../shared/engine";
import { recentExchanges } from "./display";
import { failureLine, fixedLines } from "./lines";
import type { Change, Input, TaskRecord } from "./record";
import {
  addRecord,
  closeIntakeStep,
  dropped,
  endCancelled,
  hold,
  holdsIntake,
  say,
  setTimer,
} from "./record";

const LET_ME_CHECK_MS = 1500;

export type AskWords = {
  words: string;
  utteranceId: UtteranceId | null;
  waiting: WaitingQuestion | null;
};

export function ask(
  change: Change,
  newTaskId: () => TaskId,
  { words, utteranceId, waiting }: AskWords,
): boolean {
  const trimmed = words.trim();
  if (trimmed === "") return dropped(change, "empty words");
  const { model } = change;
  if (model.notice === fixedLines.wordsNotCaught) {
    model.notice = model.voiceAvailable ? null : fixedLines.voiceUnavailable;
  }
  const taskId = newTaskId();
  const record = addRecord(model, taskId, trimmed);
  hold(change, record, {
    type: "question",
    taskId,
    utteranceId,
    words: trimmed,
    recent: recentExchanges(model, taskId),
    waiting,
  });
  record.letMeCheckDue = true;
  setTimer(change, LET_ME_CHECK_MS, letMeCheck(taskId));
  return true;
}

function letMeCheck(taskId: TaskId): Input {
  return (change) => {
    const record = change.model.records.get(taskId);
    if (record?.card.state !== "thinking" || !record.letMeCheckDue) {
      return dropped(change, `let-me-check timer for ${taskId}`);
    }
    record.letMeCheckDue = false;
    record.card.line = fixedLines.letMeCheck;
    say(change, taskId, fixedLines.letMeCheck, "letMeCheck");
    return true;
  };
}

type OtherOutcome = Extract<IntakeOutcome, { route: "outsideResearch" }>;

export function applyIntakeOutcome(
  change: Change,
  record: TaskRecord,
  outcome: OtherOutcome,
): boolean {
  if (outcome.route === "outsideResearch") {
    endCancelled(change, record, null, fixedLines.outsideResearch);
  }
  return true;
}

export function failIntake(
  change: Change,
  record: TaskRecord,
  kind: FailureKind,
): boolean {
  if (!holdsIntake(record)) {
    return dropped(change, `failure for ${record.card.taskId}`);
  }
  record.failed = record.sent;
  closeIntakeStep(record);
  const line = failureLine(kind);
  record.card.line = line;
  record.card.canRetry = true;
  say(change, record.card.taskId, line, "failure");
  return true;
}
