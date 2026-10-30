import type { TaskId, UtteranceId } from "../../shared/cards";
import { recentExchanges, roomLeft, taskSummaries } from "./display";
import { openAttempt } from "./front";
import { conversationHistory } from "./history";
import type { Change, FrontParts, TaskRecord } from "./record";
import { addRecord, clearOneOffNotice, dropped } from "./record";
import type { WaitingQuestion } from "./talk";

type AskWords = {
  words: string;
  utteranceId: UtteranceId | null;
  waiting: WaitingQuestion | null;
};

function partsFor(
  change: Change,
  record: TaskRecord,
  { words, utteranceId, waiting }: AskWords,
): FrontParts {
  const { model } = change;
  const { taskId } = record.card;
  return {
    taskId,
    utteranceId,
    words,
    history: conversationHistory(model.exchanges),
    recent: recentExchanges(model, taskId),
    tasks: taskSummaries(model),
    room: roomLeft(model),
    waiting,
  };
}

// New words get a thinking card and one front call, even while a task runs.
export function ask(
  change: Change,
  newTaskId: () => TaskId,
  { words, utteranceId, waiting }: AskWords,
): boolean {
  const trimmed = words.trim();
  if (trimmed === "") return dropped(change, "empty words");
  clearOneOffNotice(change.model);
  const record = addRecord(change.model, newTaskId(), trimmed);
  const parts = partsFor(change, record, {
    words: trimmed,
    utteranceId,
    waiting,
  });
  openAttempt(change, record, parts);
  return true;
}
