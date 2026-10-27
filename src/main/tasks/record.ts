import type {
  ClarifyingQuestion,
  Findings,
  TaskCard,
  TaskId,
  TaskState,
} from "../../shared/cards";
import type {
  EngineCommand,
  Incomplete,
  ParentResult,
  WorkerBrief,
} from "../../shared/engine";
import { incompleteLines } from "./lines";

export type SaidKind =
  "letMeCheck" | "startLine" | "question" | "answer" | "failure" | "notice";
export type SaidLine = { taskId: TaskId | null; text: string; kind: SaidKind };

export type Admission = { startLine: string; brief: WorkerBrief };

export type TaskRecord = {
  card: TaskCard;
  shown: boolean;
  created: number;
  admission: Admission | null;
  spokenLine: string | null;
  hiddenQuestion: ClarifyingQuestion | null;
  letMeCheckDue: boolean;
  sent: EngineCommand | null;
  failed: EngineCommand | null;
};

export type Model = {
  records: Map<TaskId, TaskRecord>;
  created: number;
  answers: Map<TaskId, ParentResult>;
  queue: TaskId[];
  questions: TaskId[];
  notice: string | null;
  muted: boolean;
  voiceAvailable: boolean;
};

// A change records what to send, say and time; the update path runs them after it publishes.
export type Output =
  | { kind: "send"; command: EngineCommand }
  | { kind: "say"; line: SaidLine }
  | { kind: "silence"; taskId: TaskId }
  | { kind: "timer"; ms: number; fire: Input };

export type Change = {
  model: Model;
  outputs: Output[];
  log: (message: string) => void;
};

export type Input = (change: Change) => boolean;

const LEAVE_MS = 3000;

export function createModel(): Model {
  return {
    records: new Map(),
    created: 0,
    answers: new Map(),
    queue: [],
    questions: [],
    notice: null,
    muted: false,
    voiceAvailable: true,
  };
}

export function addRecord(
  model: Model,
  taskId: TaskId,
  words: string,
): TaskRecord {
  model.created += 1;
  const record: TaskRecord = {
    card: {
      taskId,
      state: "thinking",
      words,
      parentTaskId: null,
      sayBack: null,
      line: null,
      step: null,
      sourcesRead: 0,
      question: null,
      answer: null,
      missing: null,
      canRetry: false,
      folded: false,
    },
    shown: true,
    created: model.created,
    admission: null,
    spokenLine: null,
    hiddenQuestion: null,
    letMeCheckDue: false,
    sent: null,
    failed: null,
  };
  model.records.set(taskId, record);
  return record;
}

export function hold(
  change: Change,
  record: TaskRecord,
  command: EngineCommand,
): void {
  record.sent = command;
  change.outputs.push({ kind: "send", command });
}

export function sendCancel(change: Change, record: TaskRecord): void {
  change.outputs.push({
    kind: "send",
    command: { type: "cancel", taskId: record.card.taskId },
  });
}

export function say(
  change: Change,
  taskId: TaskId | null,
  text: string,
  kind: SaidKind,
): void {
  change.outputs.push({ kind: "say", line: { taskId, text, kind } });
}

// Drops the task's pending and playing speech; never pushed in a change that then says a line for that task.
export function silence(change: Change, taskId: TaskId): void {
  change.outputs.push({ kind: "silence", taskId });
}

export function setTimer(change: Change, ms: number, fire: Input): void {
  change.outputs.push({ kind: "timer", ms, fire });
}

export function dropped(change: Change, reason: string): false {
  change.log(`dropped: ${reason}`);
  return false;
}

export function isEnded(state: TaskState): boolean {
  return state === "done" || state === "incomplete" || state === "cancelled";
}

export function holdsIntake(record: TaskRecord): boolean {
  const { state } = record.card;
  const sent = record.sent?.type;
  return (
    (state === "thinking" && sent === "question") ||
    (state === "clarifying" && sent === "clarifyingAnswer")
  );
}

export function closeIntakeStep(record: TaskRecord): void {
  record.letMeCheckDue = false;
  record.sent = null;
}

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
  record.failed = null;
  record.hiddenQuestion = null;
  record.letMeCheckDue = false;
  record.card.state = outcome;
  record.card.step = null;
}

export function endDone(
  change: Change,
  record: TaskRecord,
  spokenLine: string,
  findings: Findings,
): void {
  closeTask(change, record, "done", findings);
  record.spokenLine = spokenLine;
  record.card.answer = findings;
  record.card.line = null;
  say(change, record.card.taskId, spokenLine, "answer");
}

export function endIncomplete(
  change: Change,
  record: TaskRecord,
  incomplete: Incomplete,
): void {
  const lines = incompleteLines(incomplete, record.card.sayBack);
  closeTask(change, record, "incomplete", incomplete.findings);
  record.card.answer = incomplete.findings;
  record.card.line = lines.line;
  record.card.missing = lines.missing;
  const kind = incomplete.kind === "needsUser" ? "question" : "failure";
  say(change, record.card.taskId, lines.spoken, kind);
}

export function endCancelled(
  change: Change,
  record: TaskRecord,
  findings: Findings | null,
  line: string | null,
): void {
  closeTask(change, record, "cancelled", findings);
  const { card } = record;
  card.line = line;
  card.question = null;
  card.answer = null;
  card.missing = null;
  card.canRetry = false;
  if (line === null) silence(change, card.taskId);
  else say(change, card.taskId, line, "failure");
  setTimer(change, LEAVE_MS, leave(card.taskId));
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

export function shownQuestion(model: Model): TaskRecord | null {
  for (const record of model.records.values()) {
    if (record.card.question?.answered === false) return record;
  }
  return null;
}

// Runs after every accepted change, so a hidden question shows whatever made the shown one go.
export function showNextQuestion(change: Change): void {
  const { model } = change;
  if (shownQuestion(model) !== null) return;
  for (const taskId of [...model.questions]) {
    model.questions = model.questions.filter((id) => id !== taskId);
    const record = model.records.get(taskId);
    const question = record?.hiddenQuestion ?? null;
    if (record?.card.state !== "clarifying" || question === null) continue;
    record.card.question = { ...question, answered: false };
    record.hiddenQuestion = null;
    say(change, taskId, question.text, "question");
    return;
  }
}
