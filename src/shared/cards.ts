// Types both links carry: renderer <-> main (ipc.ts) and main <-> engine (engine.ts).

export type TaskId = string;
export type UtteranceId = string;

export type Source = {
  id: string;
  url: string;
  title: string;
};

// What a task found: a done answer, or what a failed or cancelled one had read.
export type Findings = {
  cardText: string; // Markdown with no links, empty when the worker's line was the whole answer; sources[] lists the pages the card relies on, opened through openSource (ids serve the done check)
  sources: Source[];
};

// "thinking" and "clarifying" are records main keeps without a card; a card appears once there is work.
export type TaskState =
  | "thinking"
  | "clarifying"
  | "queued"
  | "running"
  | "cancelling"
  | "done"
  | "failed"
  | "cancelled";

// Every user-facing string on a card is built by main; the engine sends kinds and model text only.
export type TaskCard = {
  taskId: TaskId;
  state: TaskState;
  words: string; // the user's words as asked
  title: string | null; // the front call's short name for the request; null until it gives one
  parentTaskId: TaskId | null;
  sayBack: string | null; // always null since the front call's spoken line replaced the say-back
  line: string | null; // a fixed status or failure line
  reply: string | null; // the front call's spoken line
  spokenLine: string | null; // a done task's result line as spoken (the answer island shows it), else null
  step: string | null; // latest progress, e.g. "searching: how Hermes works"
  sourcesRead: number;
  answer: Findings | null; // may be partial when state is "failed"
  canRetry: boolean;
};

// One side of the conversation: what the user said, or what Baymax said that was no task's card.
export type ChatEntry = {
  id: string;
  from: "user" | "baymax";
  text: string;
  at: number; // milliseconds since the epoch
};

export type DisplayState = {
  tasks: TaskCard[]; // in the order shown
  chat: ChatEntry[]; // oldest first
  notice: string | null; // a line tied to no card: words not caught, voice unavailable, restarting
  muted: boolean;
  voiceAvailable: boolean;
};
