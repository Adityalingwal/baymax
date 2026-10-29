import type { SpeakingLine, VoicePhase } from "../../shared/ipc";

// The closed-panel voice pill. Rules and timings: notch-design-locked.md, "Voice pill" and the pill close and mute sections.
export const pillDelays = { thresholdMs: 300, holdMs: 800 } as const;

export type PillWord = "Listening" | "Thinking" | "Speaking";

// wait holds the token of the running timer, so a timer that fires after its reason is gone does nothing.
export type PillState = {
  phase: VoicePhase["phase"];
  line: SpeakingLine | null; // the line speaking now
  shown: boolean;
  word: PillWord;
  muted: boolean; // the Clear label after a mute click; it stays until the pill closes
  session: number; // counts pill openings, so the corner lines draw in once per opening
  wait: { kind: "threshold" | "hold"; token: number } | null;
  tokens: number;
};

export type PillEvent =
  | { kind: "phase"; phase: VoicePhase }
  | { kind: "threshold-elapsed"; token: number }
  | { kind: "hold-elapsed"; token: number }
  | { kind: "mute-clicked" };

export const initialPill: PillState = {
  phase: "idle",
  line: null,
  shown: false,
  word: "Listening",
  muted: false,
  session: 0,
  wait: null,
  tokens: 0,
};

function startWait(state: PillState, kind: "threshold" | "hold"): PillState {
  const token = state.tokens + 1;
  return { ...state, wait: { kind, token }, tokens: token };
}

function show(state: PillState, word: PillWord): PillState {
  const session = state.shown ? state.session : state.session + 1;
  return { ...state, shown: true, word, muted: false, session, wait: null };
}

// A hold under 300 ms is a tap and never shows the pill; once it is longer, Listening shows.
function receivePhase(state: PillState, voice: VoicePhase): PillState {
  const line = voice.phase === "speaking" ? voice.line : null;
  const next = { ...state, phase: voice.phase, line };
  switch (voice.phase) {
    case "listening":
      if (state.wait?.kind === "threshold") return next;
      return startWait(next, "threshold");
    case "thinking":
      return show(next, "Thinking");
    case "speaking":
      return show(next, "Speaking");
    case "idle":
      if (!state.shown) return { ...next, wait: null };
      // A mute confirmation already counts its 800 ms from the click.
      if (state.wait?.kind === "hold") return next;
      return startWait(next, "hold");
  }
}

export function pillReducer(state: PillState, event: PillEvent): PillState {
  switch (event.kind) {
    case "phase":
      return receivePhase(state, event.phase);
    case "threshold-elapsed":
      if (state.wait?.token !== event.token || state.phase !== "listening") {
        return state;
      }
      return show(state, "Listening");
    case "hold-elapsed":
      if (state.wait?.token !== event.token) return state;
      return { ...state, shown: false, wait: null };
    case "mute-clicked":
      if (!state.shown || state.word !== "Speaking" || state.muted) {
        return state;
      }
      return startWait({ ...state, muted: true }, "hold");
  }
}
