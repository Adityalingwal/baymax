// Types both links carry: renderer <-> main (ipc.ts) and main <-> engine (engine.ts).

export type TaskId = string;
export type QuestionId = string;
export type UtteranceId = string;

export type Source = {
  id: string;
  url: string;
  title: string;
};

// No choices (an open question) or two to four, the first recommended; the screen adds "something else" itself.
export type ClarifyingQuestion = {
  questionId: QuestionId;
  text: string;
  choices: string[];
};

export type ClarifyingReply =
  { kind: "choice"; index: number } | { kind: "text"; text: string };

// What a task found: a done answer, or the labelled partial findings of an incomplete one.
export type Findings = {
  cardText: string; // Markdown with no links; sources[] lists the pages the card relies on, opened through openSource (ids serve the done check)
  sources: Source[];
  openPoints: string[]; // carried into a follow-up's brief
};

// "cancelled" also covers a card refused at the queue limit or for a request outside research; main sets its line.
export type TaskState =
  | "thinking"
  | "clarifying"
  | "queued"
  | "running"
  | "cancelling"
  | "done"
  | "incomplete"
  | "cancelled";

// Every user-facing string on a card is built by main; the engine sends kinds and model text only.
export type TaskCard = {
  taskId: TaskId;
  state: TaskState;
  words: string; // the user's words as asked
  parentTaskId: TaskId | null;
  sayBack: string | null; // always null since the front call's spoken line replaced the say-back
  line: string | null; // a fixed status or failure line
  reply: string | null; // the front call's spoken line, so what was said is also on screen
  spokenLine: string | null; // a done task's result line as spoken (the answer island shows it), else null
  step: string | null; // latest progress, e.g. "searching: how Hermes works"
  sourcesRead: number;
  question: (ClarifyingQuestion & { answered: boolean }) | null;
  answer: Findings | null; // partial exactly when state is "incomplete"
  missing: string | null; // model text on what is missing: the next question, or the unchecked part
  canRetry: boolean;
  folded: boolean;
};

export type DisplayState = {
  tasks: TaskCard[]; // in the order shown
  notice: string | null; // a line tied to no card: words not caught, voice unavailable, restarting
  muted: boolean;
  voiceAvailable: boolean;
};
