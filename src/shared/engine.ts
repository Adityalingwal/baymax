import type {
  ClarifyingQuestion,
  ClarifyingReply,
  Findings,
  QuestionId,
  TaskId,
  TaskState,
  UtteranceId,
} from "./cards";

// Only "normal" in V1; V2 adds "quick" and "deep".
export type Depth = "normal";

// The intake's four parts plus the user's exact words, since a restated goal can lose a nuance.
export type WorkerBrief = {
  goal: string;
  resultShape: string;
  sources: string;
  limits: string;
  userWords: string;
};

// Main's short record of recent questions and answers.
export type RecentExchange = {
  taskId: TaskId;
  state: TaskState;
  question: string;
  answer: string | null; // the spoken line; null until the task ends
  cardText: string | null;
};

export type WaitingQuestion = {
  taskId: TaskId;
  question: ClarifyingQuestion;
};

export type ParentResult = {
  taskId: TaskId;
  outcome: "done" | "incomplete" | "cancelled";
  findings: Findings | null; // null when nothing usable was found
};

// The engine keeps nothing across tasks, so each command carries what its step needs.
export type EngineCommand =
  | {
      type: "question";
      taskId: TaskId; // main's thinking-card id, which becomes the task's id
      utteranceId: UtteranceId | null; // null for a typed question
      words: string;
      recent: RecentExchange[];
      waiting: WaitingQuestion | null; // the question shown when the key went down
    }
  | {
      // answered by one intake event on the same taskId; never route "answer"
      type: "clarifyingAnswer";
      taskId: TaskId;
      words: string; // the task's original words
      question: ClarifyingQuestion;
      reply: ClarifyingReply;
      recent: RecentExchange[];
    }
  | {
      type: "runTask";
      taskId: TaskId;
      goalVersion: number; // always 1 in V1
      depth: Depth;
      brief: WorkerBrief;
      parent: ParentResult | null;
    }
  // only for a task the engine holds (an intake call in flight or a run); it always answers with one cancelled event and nothing after it
  | { type: "cancel"; taskId: TaskId };

export type IntakeOutcome =
  | {
      route: "newTask";
      sayBack: string;
      startLine: string;
      brief: WorkerBrief;
    }
  | {
      route: "followUp";
      parentTaskId: TaskId;
      sayBack: string;
      startLine: string;
      brief: WorkerBrief;
    }
  | {
      route: "answer"; // the words answer the waiting question; main binds it, then sends clarifyingAnswer
      waitingTaskId: TaskId;
      questionId: QuestionId;
      reply: ClarifyingReply;
    }
  | { route: "clarify"; sayBack: string; question: ClarifyingQuestion }
  | { route: "chat"; sayBack: string } // small talk the talker already answered; no worker
  | { route: "outsideResearch" };

// Structured, never page text; main builds the shown step from it.
export type ProgressStep =
  { tool: "search"; query: string } | { tool: "read"; url: string };

export type FailureKind =
  "modelsUnreachable" | "keyRejected" | "noCredit" | "searchDown" | "error";

export type Incomplete =
  | { kind: "limitHit" | "sourcesThin"; findings: Findings | null }
  | { kind: "error"; cause: FailureKind; findings: Findings | null }
  | { kind: "needsUser"; nextQuestion: string; findings: Findings | null }
  | { kind: "unchecked"; uncheckedPart: string; findings: Findings }; // a failed done check after the retry round, or a judge failure

// Events carry kinds and model-written text, never fixed user-facing lines: main owns those.
export type EngineEvent =
  | { type: "intake"; taskId: TaskId; outcome: IntakeOutcome }
  | {
      type: "progress";
      taskId: TaskId;
      step: ProgressStep;
      sourcesRead: number;
    }
  | { type: "result"; taskId: TaskId; spokenLine: string; findings: Findings }
  | { type: "incomplete"; taskId: TaskId; incomplete: Incomplete }
  | { type: "cancelled"; taskId: TaskId; findings: Findings | null } // sent after the work has really stopped; partial findings, if any, for a follow-up
  | { type: "failure"; taskId: TaskId; kind: FailureKind }; // an intake call failed; the card offers retry

// Serializable only; test fakes enter the engine's start function through its own optional parameter.
export type EngineStartOptions = {
  anthropicKey: string;
  searchKey: string; // the key of the one search provider main picks
};

// Main's end of the port; V2 swaps the in-process port for a utilityProcess behind the same type.
export type EnginePort = {
  send: (command: EngineCommand) => void;
  onMessage: (listener: (event: EngineEvent) => void) => () => void;
  close: () => void;
};
