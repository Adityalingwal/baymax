import type { QuestionId, TaskId } from "../../shared/cards";
import type { FailureKind } from "../../shared/engine";
import { checkDecision } from "./decision";
import type { Decision } from "./decision";
import { addExchange, setExchangeTask } from "./history";
import { frontFailureLine } from "./lines";
import type { Attempt, Change, FrontParts, Model, TaskRecord } from "./record";
import { dropped, say, shownQuestion, talk } from "./record";
import { admit, endChat, endOutside } from "./run";
import type { TalkerReply } from "./talk";

type Admitted = Extract<Decision, { route: "newTask" | "followUp" }>;

// Starts one front call for the record; its id is unique, so a late result of an older call is told apart.
export function openAttempt(
  change: Change,
  record: TaskRecord,
  parts: FrontParts,
  submitted: QuestionId | null,
): void {
  record.attempts += 1;
  change.model.exchangeOrder += 1;
  const id = `${record.card.taskId}#${record.attempts}`;
  const order = change.model.exchangeOrder;
  record.attempt = { id, order, parts, submitted };
  talk(change, { kind: "front", attemptId: id, ...parts });
}

// Tasks created before the given one: a follow-up names a parent only from these.
function earlierThan(model: Model, taskId: TaskId): ReadonlySet<TaskId> {
  const created = model.records.get(taskId)?.created ?? 0;
  const ids = [...model.records.values()]
    .filter((record) => record.created < created)
    .map((record) => record.card.taskId);
  return new Set(ids);
}

// A card answer names the question it answers even when the tool call leaves it out.
function withSubmitted(raw: unknown, submitted: QuestionId | null): unknown {
  if (submitted === null) return raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const given = "answerTo" in raw ? raw.answerTo : null;
  return { ...raw, answerTo: given ?? submitted };
}

function failFront(
  change: Change,
  record: TaskRecord,
  attempt: Attempt,
  failure: { kind: FailureKind; spoke: boolean },
): boolean {
  record.failedAttempt = attempt;
  const line = frontFailureLine(failure.kind, failure.spoke);
  record.card.line = line;
  record.card.canRetry = true;
  say(change, record.card.taskId, line, "failure");
  return true;
}

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
function applyDecision(
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

// The one terminal result of an attempt; a result for an attempt that is not the record's current one changes nothing.
export function receiveFront(
  change: Change,
  taskId: TaskId,
  attemptId: string,
  reply: TalkerReply,
): boolean {
  const record = change.model.records.get(taskId);
  const attempt = record?.attempt ?? null;
  if (record === undefined || attempt === null || attempt.id !== attemptId) {
    return dropped(change, `front call ${attemptId} for ${taskId}`);
  }
  record.attempt = null;
  // What was spoken is part of the conversation whether or not the decision holds.
  addExchange(change.model.exchanges, {
    order: attempt.order,
    taskId,
    words: attempt.parts.words,
    line: reply.text ?? "",
  });
  if (reply.kind === "failed") {
    const spoke = (reply.text ?? "").trim() !== "";
    return failFront(change, record, attempt, { kind: reply.failure, spoke });
  }
  const context = {
    words: attempt.parts.words,
    waiting: attempt.parts.waiting,
    taskId,
    earlier: (id: TaskId) => earlierThan(change.model, id),
  };
  const raw = withSubmitted(reply.decision, attempt.submitted);
  const check = checkDecision(raw, context);
  if (!check.ok) {
    change.log(`decision rejected for ${taskId}: ${check.reason}`);
    return failFront(change, record, attempt, { kind: "error", spoke: true });
  }
  if (check.note !== null) change.log(check.note);
  return applyDecision(change, record, attempt, check.decision, reply.text);
}

export function retryTask(change: Change, taskId: TaskId): boolean {
  const record = change.model.records.get(taskId);
  const state = record?.card.state;
  const failed = record?.failedAttempt ?? null;
  if (
    record === undefined ||
    (state !== "thinking" && state !== "clarifying") ||
    !record.card.canRetry ||
    failed === null ||
    record.attempt !== null
  ) {
    return dropped(change, `retry ${taskId}`);
  }
  record.card.canRetry = false;
  record.card.line = null;
  record.failedAttempt = null;
  openAttempt(change, record, failed.parts, failed.submitted);
  return true;
}
