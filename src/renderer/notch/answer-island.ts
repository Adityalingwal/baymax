import type { TaskId } from "../../shared/cards";
import type { LineId, VoicePhase } from "../../shared/ipc";
import { closedTiming } from "./closed-plans";

// The answer island's life, from its result line's first audio until main hears it has closed.
// Rules: design-lock-panel-contents.md, "Answer island"; the close motion: closed-plans.ts.
export const islandDelays = {
  closeMs: 2000, // after the line ends, counted only while the pointer is off
  closingMs: closedTiming.shapeMs,
} as const;

// wait holds the token of the running timer, so a timer that fires after its reason is gone does nothing.
export type IslandState = {
  line: LineId | null; // the result line it belongs to
  taskId: TaskId | null;
  shown: boolean;
  speaking: boolean; // that line still plays
  pointerOn: boolean;
  panelOpen: boolean;
  wait: { kind: "close" | "closing"; token: number } | null;
  tokens: number;
  closed: LineId | null; // the last result line whose island has finished closing
};

export type IslandEvent =
  | { kind: "phase"; phase: VoicePhase; eligible: boolean }
  | { kind: "pointer"; on: boolean }
  | { kind: "panel"; open: boolean }
  | { kind: "close-elapsed"; token: number }
  | { kind: "closing-elapsed"; token: number };

export const initialIsland: IslandState = {
  line: null,
  taskId: null,
  shown: false,
  speaking: false,
  pointerOn: false,
  panelOpen: false,
  wait: null,
  tokens: 0,
  closed: null,
};

// Every result line gets one closing report, even with no island: main's next result waits for it.
function receivePhase(
  state: IslandState,
  voice: VoicePhase,
  eligible: boolean,
): IslandState {
  const line = voice.phase === "speaking" ? voice.line : null;
  if (line !== null && line.lineId === state.line) return state;
  if (line?.kind === "answer") {
    return {
      ...state,
      line: line.lineId,
      taskId: line.taskId,
      shown: eligible && !state.panelOpen,
      speaking: true,
    };
  }
  const ended = { ...state, speaking: false };
  // The key silences the line and closes the island at once.
  return voice.phase === "listening" ? { ...ended, shown: false } : ended;
}

function applyEvent(state: IslandState, event: IslandEvent): IslandState {
  switch (event.kind) {
    case "phase":
      return receivePhase(state, event.phase, event.eligible);
    case "pointer":
      return { ...state, pointerOn: event.on };
    // An open panel holds the result itself, so the island goes.
    case "panel":
      return {
        ...state,
        panelOpen: event.open,
        shown: event.open ? false : state.shown,
      };
    case "close-elapsed":
      return event.token === state.wait?.token
        ? { ...state, shown: false }
        : state;
    case "closing-elapsed":
      return event.token === state.wait?.token
        ? { ...state, line: null, taskId: null, closed: state.line }
        : state;
  }
}

// Which timer the facts ask for; a timer already running keeps running.
function settle(state: IslandState): IslandState {
  const { shown, speaking, pointerOn, line } = state;
  const closing = line !== null && !shown && !speaking;
  const kind =
    shown && !speaking && !pointerOn ? "close" : closing ? "closing" : null;
  if (kind === null) return { ...state, wait: null };
  if (state.wait?.kind === kind) return state;
  const token = state.tokens + 1;
  return { ...state, wait: { kind, token }, tokens: token };
}

function sameState(a: IslandState, b: IslandState): boolean {
  const keys = Object.keys(a) as (keyof IslandState)[];
  return keys.every((key) => a[key] === b[key]);
}

// Returns the same object when nothing changes, so React skips the render.
export function islandReducer(
  state: IslandState,
  event: IslandEvent,
): IslandState {
  const next = settle(applyEvent(state, event));
  return sameState(state, next) ? state : next;
}

// The speaking line is the one the island shows; the pill's own close rules step aside for it.
export function islandSpeaks(state: IslandState, phase: VoicePhase): boolean {
  return (
    state.shown &&
    phase.phase === "speaking" &&
    phase.line.lineId === state.line
  );
}
