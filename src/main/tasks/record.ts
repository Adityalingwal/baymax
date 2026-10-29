import type {
  ClarifyingQuestion,
  QuestionId,
  TaskCard,
  TaskId,
  TaskState,
} from "../../shared/cards";
import type { EngineCommand, ParentResult, TaskAsk } from "../../shared/engine";
import type { Exchange } from "./history";
import type { TalkRequest } from "./talk";

// Main's state says fixed lines (failure, notice, queue), results and the waiting question as given; the front call says the rest.
export type SaidKind = "talk" | "question" | "answer" | "failure" | "notice";
export type SaidLine = { taskId: TaskId | null; text: string; kind: SaidKind };

export type Admission = { ask: TaskAsk };

// Everything a front call is asked except its id; a retry makes a fresh call from the same parts.
export type FrontParts = Omit<TalkRequest, "kind" | "attemptId">;

// One front call in flight or failed; submitted is the question a card answer claimed when it started.
export type Attempt = {
  id: string;
  order: number; // the exchange's place in the conversation, fixed when the call starts
  parts: FrontParts;
  submitted: QuestionId | null;
};

export type TaskRecord = {
  card: TaskCard;
  shown: boolean;
  created: number;
  admission: Admission | null;
  topic: string | null; // the front call's short name for the request; never on the card
  spokenLine: string | null;
  hiddenQuestion: ClarifyingQuestion | null;
  builtOnPartial: boolean;
  attempt: Attempt | null;
  failedAttempt: Attempt | null;
  attempts: number;
  sent: EngineCommand | null;
};

export type Model = {
  records: Map<TaskId, TaskRecord>;
  created: number;
  answers: Map<TaskId, ParentResult>;
  exchanges: Exchange[];
  exchangeOrder: number;
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
  | { kind: "talk"; request: TalkRequest }
  | { kind: "cancelAttempt"; attemptId: string }
  | { kind: "silence"; taskId: TaskId }
  | { kind: "timer"; ms: number; fire: Input };

export type Change = {
  model: Model;
  outputs: Output[];
  log: (message: string) => void;
};

export type Input = (change: Change) => boolean;

export function createModel(): Model {
  return {
    records: new Map(),
    created: 0,
    answers: new Map(),
    exchanges: [],
    exchangeOrder: 0,
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
      reply: null,
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
    topic: null,
    spokenLine: null,
    hiddenQuestion: null,
    builtOnPartial: false,
    attempt: null,
    failedAttempt: null,
    attempts: 0,
    sent: null,
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

export function talk(change: Change, request: TalkRequest): void {
  change.outputs.push({ kind: "talk", request });
}

// Aborts the record's front call, if any; the late result of that call changes nothing.
export function abandonAttempt(change: Change, record: TaskRecord): boolean {
  const { attempt } = record;
  if (attempt === null) return false;
  record.attempt = null;
  change.outputs.push({ kind: "cancelAttempt", attemptId: attempt.id });
  return true;
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
