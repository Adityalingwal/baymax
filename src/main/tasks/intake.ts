import type {
  ClarifyingQuestion,
  ClarifyingReply,
  TaskId,
  UtteranceId,
} from "../../shared/cards";
import type {
  FailureKind,
  IntakeOutcome,
  WaitingQuestion,
} from "../../shared/engine";
import type { AnswerQuestion } from "../../shared/ipc";
import { recentExchanges } from "./display";
import { failureLine, fixedLines } from "./lines";
import { clearOneOffNotice } from "./notices";
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

type AskWords = {
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
  clearOneOffNotice(model);
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

type OtherOutcome = Exclude<
  IntakeOutcome,
  { route: "newTask" } | { route: "followUp" }
>;

export function applyIntakeOutcome(
  change: Change,
  record: TaskRecord,
  outcome: OtherOutcome,
): boolean {
  switch (outcome.route) {
    case "outsideResearch":
      endCancelled(change, record, null, fixedLines.outsideResearch);
      return true;
    case "clarify":
      clarify(change, record, outcome.sayBack, outcome.question);
      return true;
    case "answer":
      removeThinkingCard(change, record);
      bindAnswer(change, {
        taskId: outcome.waitingTaskId,
        questionId: outcome.questionId,
        reply: outcome.reply,
      });
      return true;
  }
}

// The update path shows the question when no other one is shown.
function clarify(
  change: Change,
  record: TaskRecord,
  sayBack: string,
  question: ClarifyingQuestion,
): void {
  const { card } = record;
  card.state = "clarifying";
  card.sayBack = sayBack;
  card.line = null;
  card.canRetry = false;
  card.question = null;
  record.hiddenQuestion = question;
  change.model.questions.push(card.taskId);
}

// Words that answer the waiting question are not a task, so their card goes at once.
function removeThinkingCard(change: Change, record: TaskRecord): void {
  change.model.records.delete(record.card.taskId);
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
    !validReply(question, reply)
  ) {
    return dropped(change, `answer for ${taskId} question ${questionId}`);
  }
  question.answered = true;
  hold(change, record, {
    type: "clarifyingAnswer",
    taskId,
    words: record.card.words,
    question: {
      questionId,
      text: question.text,
      choices: [...question.choices],
    },
    reply,
    recent: recentExchanges(change.model, taskId),
  });
  return true;
}

export function retryTask(change: Change, taskId: TaskId): boolean {
  const record = change.model.records.get(taskId);
  const state = record?.card.state;
  const failed = record?.failed ?? null;
  if (
    record === undefined ||
    (state !== "thinking" && state !== "clarifying") ||
    !record.card.canRetry ||
    failed === null
  ) {
    return dropped(change, `retry ${taskId}`);
  }
  record.card.canRetry = false;
  record.card.line = null;
  record.failed = null;
  hold(change, record, failed);
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
