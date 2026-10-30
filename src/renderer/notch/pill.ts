import type { LineId, SpeakingLine, VoicePhase } from "../../shared/ipc";

// The closed-panel voice pill and the answer island it grows into. Rules and timings: notch-design-locked.md,
// "Voice pill", the pill close and mute sections, and "Task finish", with design-lock-timing.md's updates.
export const pillDelays = { thresholdMs: 50, holdMs: 800 } as const;

export type PillWord = "Listening" | "Thinking" | "Speaking";

// How the pill's next close moves: soft after speech or under mute, silent when a hold ended with nothing said.
export type PillClose = "soft" | "silent";

// wait holds the token of the running timer, so a timer that fires after its reason is gone does nothing.
export type PillState = {
  phase: VoicePhase["phase"];
  line: SpeakingLine | null; // the line speaking now
  island: boolean; // that line is a done task's answer, so the pill grows into the answer island
  dismissed: LineId | null; // a line whose island was clicked open: it goes on as a plain pill line
  shown: boolean;
  word: PillWord;
  muted: boolean; // the Clear label after a mute click; it stays until the pill closes
  mainMuted: boolean; // main's mute
  close: PillClose;
  session: number; // counts pill openings, so the corner lines draw in once per opening
  wait: { kind: "threshold" | "hold"; token: number } | null;
  tokens: number;
};

export type PillEvent =
  | { kind: "phase"; phase: VoicePhase; answer: boolean }
  | { kind: "main-muted"; muted: boolean }
  | { kind: "threshold-elapsed"; token: number }
  | { kind: "hold-elapsed"; token: number }
  | { kind: "mute-clicked" }
  | { kind: "open-result" };

export const initialPill: PillState = {
  phase: "idle",
  line: null,
  island: false,
  dismissed: null,
  shown: false,
  word: "Listening",
  muted: false,
  mainMuted: false,
  close: "soft",
  session: 0,
  wait: null,
  tokens: 0,
};

// The island shows while its line speaks, unless it was clicked open.
export function islandShown(state: PillState): boolean {
  const { shown, island, line, dismissed } = state;
  return shown && island && line !== null && line.lineId !== dismissed;
}

function startWait(state: PillState, kind: "threshold" | "hold"): PillState {
  const token = state.tokens + 1;
  return { ...state, wait: { kind, token }, tokens: token };
}

function show(state: PillState, word: PillWord): PillState {
  const session = state.shown ? state.session : state.session + 1;
  return {
    ...state,
    shown: true,
    word,
    muted: false,
    close: "soft",
    session,
    wait: null,
  };
}

// After speech: the pill holds 800 ms, the island closes at once.
// A hold that ends in Listening or Thinking has no line to hold after: it closes at once, faster unless muted.
function speechEnded(state: PillState, next: PillState): PillState {
  if (!state.shown) return { ...next, wait: null };
  if (islandShown(state)) return { ...next, shown: false, wait: null };
  if (state.phase === "thinking" || state.word === "Listening") {
    const close = state.mainMuted ? "soft" : "silent";
    return { ...next, shown: false, close, wait: null };
  }
  // A mute confirmation already counts its 800 ms from the click.
  if (state.wait?.kind === "hold") return next;
  return startWait(next, "hold");
}

// A hold under 50 ms never shows the pill; once it is longer, Listening shows.
function receivePhase(
  state: PillState,
  voice: VoicePhase,
  answer: boolean,
): PillState {
  const line = voice.phase === "speaking" ? voice.line : null;
  const island = line !== null && answer;
  const next = { ...state, phase: voice.phase, line, island };
  switch (voice.phase) {
    case "listening":
      if (state.wait?.kind === "threshold") return next;
      // The key silences the island's line, so the island closes at once; a real hold then shows Listening.
      if (islandShown(state)) {
        return startWait({ ...next, shown: false }, "threshold");
      }
      return startWait(next, "threshold");
    case "thinking":
      return show(next, "Thinking");
    case "speaking":
      return show(next, "Speaking");
    case "idle":
      return speechEnded(state, next);
  }
}

// On the island there is no 800 ms confirmation: the line stops, and the island closes when it ends.
function muteClicked(state: PillState): PillState {
  if (!state.shown || state.word !== "Speaking" || state.muted) return state;
  const muted = { ...state, muted: true };
  return islandShown(state) ? muted : startWait(muted, "hold");
}

export function pillReducer(state: PillState, event: PillEvent): PillState {
  switch (event.kind) {
    case "phase":
      return receivePhase(state, event.phase, event.answer);
    case "main-muted":
      return { ...state, mainMuted: event.muted };
    case "threshold-elapsed":
      if (state.wait?.token !== event.token || state.phase !== "listening") {
        return state;
      }
      return show(state, "Listening");
    case "hold-elapsed":
      if (state.wait?.token !== event.token) return state;
      return { ...state, shown: false, wait: null };
    case "mute-clicked":
      return muteClicked(state);
    case "open-result":
      return state.line === null
        ? state
        : { ...state, dismissed: state.line.lineId };
  }
}
