import type { ChatEntry, TaskCard, TaskId } from "../../shared/cards";
import type {
  EngineCommand,
  FailureCause,
  ParentResult,
  TaskAsk,
} from "../../shared/engine";
import type { SpokenKind } from "../../shared/ipc";
import type { Exchange } from "./history";
import { fixedLines } from "./lines";
import type {
  ClarifyingQuestion,
  FrontRequest,
  QuestionId,
  RetryOffer,
  TalkRequest,
} from "./talk";

// Main's state says fixed lines (failure, notice), results and a re-asked question as given; the front call says the rest.
export type SaidKind = SpokenKind;
export type SaidLine = { taskId: TaskId | null; text: string; kind: SaidKind };

export type Admission = { ask: TaskAsk };

// Everything a front call is asked except its id.
export type FrontParts = Omit<FrontRequest, "kind" | "attemptId">;

// One front call in flight.
export type Attempt = {
  id: string;
  order: number; // the exchange's place in the conversation, fixed when the call starts
  parts: FrontParts;
};

// A failed task whose talker call has not started; cause is what the call is told, kind decides what it offers.
export type PendingFailure = {
  taskId: TaskId;
  cause: string;
  kind: FailureCause;
};

// The one failure turn in flight.
export type FailureCall = PendingFailure & { attemptId: string };

export type TaskRecord = {
  card: TaskCard;
  shown: boolean;
  created: number;
  admission: Admission | null;
  topic: string | null; // the front call's short name for the request; the card shows it as its title
  spokenLine: string | null;
  question: ClarifyingQuestion | null; // held in state clarifying until it is answered or stopped
  attempt: Attempt | null;
  attempts: number;
  sent: EngineCommand | null;
  retried: boolean; // limits only what the talker offers, never the card's Retry
  failedAt: number; // the exchange order when it last failed
};

export type Model = {
  records: Map<TaskId, TaskRecord>;
  created: number;
  answers: Map<TaskId, ParentResult>;
  exchanges: Exchange[];
  exchangeOrder: number;
  queue: TaskId[];
  finishes: number; // how many shown tasks ever ended, for the cards' finish order
  pendingFailures: PendingFailure[]; // in the order they failed
  failureCall: FailureCall | null;
  voiceIdle: boolean; // no key held, no line playing, no spoken turn pending
  offers: RetryOffer[];
  offersMade: number; // how many were ever made, for their order
  questions: { taskId: TaskId; order: number }[]; // the records holding a question, in the order spoken
  askedQuestion: QuestionId | null; // the question the user last heard as the active one
  chat: ChatEntry[];
  chatEntries: number; // how many were ever added, for their ids
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
  | { kind: "cutFailure"; taskId: TaskId }
  | { kind: "timer"; ms: number; fire: Input };

export type Change = {
  model: Model;
  outputs: Output[];
  now: () => Date;
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
    finishes: 0,
    pendingFailures: [],
    failureCall: null,
    voiceIdle: true,
    offers: [],
    offersMade: 0,
    questions: [],
    askedQuestion: null,
    chat: [],
    chatEntries: 0,
    notice: null,
    muted: false,
    voiceAvailable: true,
  };
}

// New words are a record with no card; only work becomes a shown card.
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
      title: null,
      parentTaskId: null,
      line: null,
      spokenLine: null,
      step: null,
      answer: null,
      canRetry: false,
      finishOrder: null,
    },
    shown: false,
    created: model.created,
    admission: null,
    topic: null,
    spokenLine: null,
    question: null,
    attempt: null,
    attempts: 0,
    sent: null,
    retried: false,
    failedAt: 0,
  };
  model.records.set(taskId, record);
  return record;
}

export function nextAttemptId(record: TaskRecord): string {
  record.attempts += 1;
  return `${record.card.taskId}#${record.attempts}`;
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

const CHAT_LIMIT = 200;

export function addChat(
  change: Change,
  from: ChatEntry["from"],
  text: string,
): void {
  const { model } = change;
  model.chatEntries += 1;
  const at = change.now().getTime();
  model.chat.push({ id: `c${model.chatEntries}`, from, text, at });
  if (model.chat.length > CHAT_LIMIT) model.chat.shift();
}

// The latest question spoken is the active one; an older one stays pending.
export function activeQuestion(model: Model): TaskRecord | null {
  const latest = model.questions.at(-1);
  return latest === undefined
    ? null
    : (model.records.get(latest.taskId) ?? null);
}

// A slower call's decision can arrive after a later call's, so a question takes its place by when its call started, which is when its line got its turn to speak.
export function holdQuestion(
  change: Change,
  record: TaskRecord,
  text: string,
  order: number,
): void {
  const { model } = change;
  const { taskId } = record.card;
  record.question = { questionId: `${taskId}:question`, text };
  model.questions = [...model.questions, { taskId, order }].sort(
    (a, b) => a.order - b.order,
  );
  model.askedQuestion = activeQuestion(model)?.question?.questionId ?? null;
}

export function dropQuestion(model: Model, record: TaskRecord): void {
  record.question = null;
  model.questions = model.questions.filter(
    ({ taskId }) => taskId !== record.card.taskId,
  );
}

// Runs after every accepted change: when the active question went away, the older one is asked again in its stored words.
export function reAskOlderQuestion(change: Change): void {
  const { model } = change;
  const record = activeQuestion(model);
  const question = record?.question ?? null;
  const questionId = question?.questionId ?? null;
  if (questionId === model.askedQuestion) return;
  model.askedQuestion = questionId;
  if (record === null || question === null) return;
  say(change, record.card.taskId, question.text, "question");
  addChat(change, "baymax", question.text);
}

export type Notice =
  "wordsNotCaught" | "micBlocked" | "noMicrophone" | "restarting";

export type VoiceDownNotice = "voiceUnavailable" | "keyMissing";

const oneOffLines: readonly string[] = [
  fixedLines.wordsNotCaught,
  fixedLines.micBlocked,
  fixedLines.noMicrophone,
];

// Restarting outranks voice unavailable, which outranks the one-off lines; among those the last one wins.
function rank(notice: string | null): number {
  if (notice === fixedLines.restarting) return 3;
  if (notice === fixedLines.voiceUnavailable) return 2;
  if (notice === fixedLines.keyMissing) return 2;
  return notice === null ? 0 : 1;
}

export function showNotice(change: Change, notice: Notice): boolean {
  const { model } = change;
  const line = fixedLines[notice];
  if (model.notice === fixedLines.restarting) {
    return dropped(change, `notice ${notice} after restarting`);
  }
  if (rank(model.notice) > rank(line)) {
    return dropped(change, `notice ${notice} under a higher notice`);
  }
  model.notice = line;
  say(change, null, line, "notice");
  return true;
}

export function setVoiceAvailable(
  change: Change,
  available: boolean,
  down: VoiceDownNotice,
): boolean {
  const { model } = change;
  if (model.voiceAvailable === available) {
    return dropped(change, "same voice availability");
  }
  model.voiceAvailable = available;
  const downLine = fixedLines[down];
  if (!available && rank(model.notice) < rank(downLine)) {
    model.notice = downLine;
    say(change, null, downLine, "notice");
  }
  if (available && model.notice === fixedLines.voiceUnavailable) {
    model.notice = null;
  }
  return true;
}

// A question was asked, so a one-off line has done its job; voice unavailable stays while voice is down.
export function clearOneOffNotice(model: Model): void {
  if (model.notice === null || !oneOffLines.includes(model.notice)) return;
  model.notice = model.voiceAvailable ? null : fixedLines.voiceUnavailable;
}
