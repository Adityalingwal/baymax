import type { TaskCard } from "../../shared/cards";
import { cardForm } from "../cards/forms";

export type ShellMode = "idle" | "dot" | "open";

type CardFields = Pick<TaskCard, "taskId" | "state" | "folded">;

// Everything but the pointer that may hold the shell open.
export type ShellReasons = {
  needsAccess: boolean; // the Accessibility hint in the top bar must stay visible
  typing: boolean;
  voice: boolean;
  notice: string | null;
  tasks: readonly CardFields[];
};

export type PointerState = { hovered: boolean; waitForExit: boolean };

const isFolded = (card: CardFields) => cardForm(card) === "folded";

export function shellMode(input: ShellReasons & PointerState): ShellMode {
  const { needsAccess, typing, voice, notice, tasks } = input;
  const unfolded = tasks.some((card) => !isFolded(card));
  if (needsAccess || typing || voice || notice !== null || unfolded) {
    return "open";
  }
  const { hovered, waitForExit } = input;
  if (hovered && !waitForExit) return "open";
  return tasks.some(isFolded) ? "dot" : "idle";
}

export function lastFoldedCard<C extends CardFields>(
  tasks: readonly C[],
): C | null {
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (isFolded(tasks[index])) return tasks[index];
  }
  return null;
}

// True when a card that was showing was folded or removed.
export function foldedOrClosed(
  previous: readonly CardFields[],
  current: readonly CardFields[],
): boolean {
  const now = new Map(current.map((card) => [card.taskId, card]));
  return previous.some((card) => {
    if (isFolded(card)) return false;
    const after = now.get(card.taskId);
    return after === undefined || isFolded(after);
  });
}

export type PointerChange =
  | { kind: "inside" }
  | { kind: "outside-after-delay" }
  | { kind: "left-window" }
  | { kind: "blur" }
  | { kind: "folded-or-closed" }
  | { kind: "outside-collapsed" };

export const initialPointer: PointerState = {
  hovered: false,
  waitForExit: false,
};

function nextPointer(state: PointerState, event: PointerChange): PointerState {
  switch (event.kind) {
    case "inside":
      return state.waitForExit ? state : { ...state, hovered: true };
    case "outside-after-delay":
    case "blur":
      return { ...state, hovered: false };
    case "left-window":
      return initialPointer;
    case "folded-or-closed":
      return { hovered: false, waitForExit: state.hovered };
    case "outside-collapsed":
      return { ...state, waitForExit: false };
  }
}

// Returns the same object when nothing changes, so React skips the render.
export function pointerReducer(
  state: PointerState,
  event: PointerChange,
): PointerState {
  const next = nextPointer(state, event);
  const same =
    next.hovered === state.hovered && next.waitForExit === state.waitForExit;
  return same ? state : next;
}

// Main reports "listening" at key-down; its hold filter (holdLimits.shortestMs, 300 ms) discards a shorter hold.
export const voiceTiming = { thresholdMs: 300, lingerMs: 3000 } as const;

// hold counts the holds, so a timer from an earlier hold is ignored.
export type VoiceState = { hold: number; listening: boolean; voice: boolean };

export type VoiceEvent =
  | { kind: "listening-started" }
  | { kind: "threshold-elapsed"; hold: number }
  | { kind: "listening-ended" }
  | { kind: "linger-elapsed"; hold: number };

export const initialVoice: VoiceState = {
  hold: 0,
  listening: false,
  voice: false,
};

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.kind) {
    case "listening-started":
      if (state.listening) return state;
      return { ...state, hold: state.hold + 1, listening: true };
    case "threshold-elapsed":
      if (event.hold !== state.hold || !state.listening || state.voice) {
        return state;
      }
      return { ...state, voice: true };
    case "listening-ended":
      return state.listening ? { ...state, listening: false } : state;
    case "linger-elapsed":
      if (event.hold !== state.hold || state.listening || !state.voice) {
        return state;
      }
      return { ...state, voice: false };
  }
}
