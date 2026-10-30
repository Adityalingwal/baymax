import type {
  ClarifyingQuestion,
  TaskId,
  TaskState,
  UtteranceId,
} from "../../shared/cards";
import type { FailureKind } from "../../shared/engine";

// A task the front call hears about, so its line and route fit what is already running or waiting.
export type TaskSummary = {
  taskId: TaskId;
  state: TaskState;
  words: string;
  topic: string | null;
};

// Main's short record of a recent task: the question, the spoken answer and a bounded excerpt of the card.
export type RecentExchange = {
  taskId: TaskId;
  state: TaskState;
  question: string;
  answer: string | null; // the spoken line; null until the task ends
  cardText: string | null;
};

// The clarifying question shown when the words were asked, with the request it belongs to.
export type WaitingQuestion = {
  taskId: TaskId;
  words: string; // the request's original words
  question: ClarifyingQuestion;
};

export type HistoryTurn = { role: "user" | "assistant"; text: string };

// What main asks the front call for: a spoken line about new words, then a decision about them.
export type TalkRequest = {
  kind: "front";
  attemptId: string; // unique per call, so a late result of an older call is ignored
  taskId: TaskId;
  utteranceId: UtteranceId | null; // null for a typed question or a card answer
  words: string;
  history: HistoryTurn[];
  recent: RecentExchange[];
  tasks: TaskSummary[];
  waiting: WaitingQuestion | null;
};

// The generation a front call belongs to, for its timing: its utterance, or its typed question.
export function frontKey(talk: {
  taskId: TaskId;
  utteranceId: UtteranceId | null;
}): string {
  return talk.utteranceId ?? `typed:${talk.taskId}`;
}

// How a front call went; decision is the decide tool's raw input, or null when no tool came.
// A failed call still carries the line it spoke before failing, so the conversation keeps it.
export type TalkerReply =
  | { kind: "said"; text: string; decision: unknown }
  | { kind: "failed"; failure: FailureKind; text?: string };
