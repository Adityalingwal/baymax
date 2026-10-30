import type { Findings, TaskId } from "./cards";

// Only "normal" in V1; V2 adds "quick" and "deep".
export type Depth = "normal";

// The front call's one-line goal plus the user's exact words; the worker reads both.
export type TaskAsk = { goal: string; userWords: string };

export type ParentResult = {
  taskId: TaskId;
  outcome: "done" | "failed" | "cancelled";
  goal: string | null; // null for a record that never had an ask, such as a chat result
  words: string; // the ask's words, or the card's when there was no ask
  spokenLine: string | null; // a done result's line, kept even when its report is empty
  findings: Findings | null; // null when nothing usable was found
};

// The engine keeps nothing across tasks, so each command carries what its step needs.
export type EngineCommand =
  | {
      type: "runTask";
      taskId: TaskId;
      goalVersion: number; // always 1 in V1
      depth: Depth;
      ask: TaskAsk;
      parent: ParentResult | null;
    }
  // only for a task the engine holds (a run); it always answers with one cancelled event and nothing after it
  | { type: "cancel"; taskId: TaskId };

// Structured, never page text; main builds the shown step from it.
export type ProgressStep =
  { tool: "search"; query: string } | { tool: "read"; url: string };

export type FailureKind =
  | "modelsUnreachable"
  | "keyRejected"
  | "noCredit"
  | "searchDown"
  | "searchKeyRejected"
  | "searchQuota"
  | "error";

// Why a task ended failed: a failure above, nothing found, or a limit.
export type FailureCause = FailureKind | "nothingFound" | "limitHit";

// Events carry kinds and model-written text, never fixed user-facing lines: main owns those.
export type EngineEvent =
  | {
      type: "progress";
      taskId: TaskId;
      step: ProgressStep;
    }
  | { type: "result"; taskId: TaskId; spokenLine: string; findings: Findings }
  | {
      type: "failed";
      taskId: TaskId;
      cause: FailureCause;
      reason: string | null; // the worker's own sentence when it found nothing
      findings: Findings | null;
    }
  | { type: "cancelled"; taskId: TaskId; findings: Findings | null }; // sent after the work has really stopped; partial findings, if any, for a follow-up

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
