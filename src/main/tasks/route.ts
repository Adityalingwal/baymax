import type { Change, Attempt, TaskRecord } from "./record";
import type { Decision } from "./decision";
import { endChat, endOutside } from "./end";
import { setExchangeTask } from "./history";
import { admit } from "./run";
import { shownQuestion } from "./questions";

// The question the answer is for, claimed now; null when it is stale or another answer already took it.
function claimTarget(
  change: Change,
  record: TaskRecord,
  attempt: Attempt,
  answerTo: string,
): TaskRecord | null {
  const waiting = attempt.parts.waiting;
  const target =
    waiting === null ? undefined : change.model.records.get(waiting.taskId);
  const question = target?.card.question ?? null;
  if (
    target === undefined ||
    target.card.state !== "clarifying" ||
    question === null ||
    question.questionId !== answerTo
  ) {
    return null;
  }
  // A card answer claimed its question when it started; a spoken one claims it here.
  if (attempt.submitted !== null) {
    return target === record && question.answered ? target : null;
  }
  if (question.answered) return null;
  question.answered = true;
  return target;
}

// The question appears at once when none is shown, else it waits hidden and is said when it shows.
function clarify(
  change: Change,
  record: TaskRecord,
  topic: string,
  question: { text: string; choices: string[] },
): void {
  const { card } = record;
  const { model } = change;
  record.topic = topic;
  card.state = "clarifying";
  card.sayBack = null;
  card.line = null;
  card.reply = null;
  card.canRetry = false;
  const full = { questionId: `${card.taskId}:question`, ...question };
  if (shownQuestion(model) === null) {
    card.question = { ...full, answered: false };
    return;
  }
  card.question = null;
  record.hiddenQuestion = full;
  model.questions.push(card.taskId);
}

type Admitted = Extract<Decision, { route: "newTask" | "followUp" }>;

// The record the decision is for: the asking record, or the waiting one the words answer; null when the answer lost.
function resolveTarget(
  change: Change,
  record: TaskRecord,
  attempt: Attempt,
  decision: Decision,
): TaskRecord | null {
  if (decision.answerTo === null) return record;
  const claimed = claimTarget(change, record, attempt, decision.answerTo);
  if (claimed === null) {
    change.log(`answer ${decision.answerTo} for ${record.card.taskId} lost`);
    // A spoken answer's temporary card goes; a stale answer starts nothing.
    if (attempt.submitted === null) {
      change.model.records.delete(record.card.taskId);
    }
    return null;
  }
  // Words that answer the waiting question are not a task, so their thinking card goes at once.
  if (claimed !== record) change.model.records.delete(record.card.taskId);
  return claimed;
}

// Applies a checked decision. The spoken line is already out; the card shows it unless a route says otherwise.
export function applyDecision(
  change: Change,
  record: TaskRecord,
  attempt: Attempt,
  decision: Decision,
  line: string,
): boolean {
  const target = resolveTarget(change, record, attempt, decision);
  if (target === null) return true;
  setExchangeTask(change.model.exchanges, attempt.order, target.card.taskId);
  switch (decision.route) {
    case "chat":
      endChat(change, target, line);
      return true;
    case "outsideResearch":
      endOutside(change, target, line);
      return true;
    case "clarify":
      clarify(change, target, decision.topic, {
        text: line,
        choices: decision.choices,
      });
      return true;
    case "newTask":
    case "followUp":
      return admit(change, target, decision satisfies Admitted, line);
  }
}
