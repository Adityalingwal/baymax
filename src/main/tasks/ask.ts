import type {
  ClarifyingQuestion,
  ClarifyingReply,
  TaskId,
  UtteranceId,
} from "../../shared/cards";
import type { AnswerQuestion } from "../../shared/ipc";
import { recentExchanges, taskSummaries } from "./display";
import { openAttempt } from "./front";
import { conversationHistory } from "./history";
import { clearOneOffNotice } from "./lines";
import type { Change, FrontParts, TaskRecord } from "./record";
import { addRecord, dropped } from "./record";
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
    tasks: taskSummaries(model, taskId),
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
  openAttempt(change, record, parts, null);
  return true;
}

function validReply(
  question: ClarifyingQuestion,
  reply: ClarifyingReply,
): boolean {
  if (reply.kind === "text") return reply.text.trim() !== "";
  return (
    Number.isInteger(reply.index) &&
    reply.index >= 0 &&
    reply.index < question.choices.length
  );
}

function replyWords(
  question: ClarifyingQuestion,
  reply: ClarifyingReply,
): string {
  return reply.kind === "choice"
    ? question.choices[reply.index]
    : reply.text.trim();
}

// A click or typed answer on the question card claims the question now and runs the front call with the answer as the words.
export function bindAnswer(
  change: Change,
  { taskId, questionId, reply }: AnswerQuestion,
): boolean {
  const record = change.model.records.get(taskId);
  const question = record?.card.question ?? null;
  if (
    record?.card.state !== "clarifying" ||
    question === null ||
    question.answered ||
    question.questionId !== questionId ||
    record.attempt !== null ||
    !validReply(question, reply)
  ) {
    return dropped(change, `answer for ${taskId} question ${questionId}`);
  }
  question.answered = true;
  const waiting: WaitingQuestion = {
    taskId,
    words: record.card.words,
    question: {
      questionId,
      text: question.text,
      choices: [...question.choices],
    },
  };
  const parts = partsFor(change, record, {
    words: replyWords(question, reply),
    utteranceId: null,
    waiting,
  });
  openAttempt(change, record, parts, questionId);
  return true;
}
