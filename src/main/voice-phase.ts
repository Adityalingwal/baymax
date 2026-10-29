import type { TaskId, UtteranceId } from "../shared/cards";
import type { LineId, SpeakingLine, VoicePhase } from "../shared/ipc";
import type { Spoken } from "./speech-model";

// An accepted hold whose turn has not spoken yet; taskId is known once its front call's line is queued.
type Pending = { key: UtteranceId; taskId: TaskId | null };

type Tracker = {
  held: boolean;
  pending: Pending | null;
  speaking: SpeakingLine | null;
};

export type PhaseTracker = {
  holdStarted(): void;
  holdEnded(accepted: UtteranceId | null): void;
  turnEnded(utteranceId: UtteranceId): void; // not caught or dropped
  asked(utteranceId: UtteranceId): void; // its words went to main's state
  talkQueued(spoken: Spoken): void;
  audioStarted(spoken: Spoken, lineId: LineId): void;
  lineGone(spoken: Spoken, lineId: LineId | null): void;
  reset(): void;
};

// Listening wins, then the line playing, then the pending turn.
function phaseOf(tracker: Tracker): VoicePhase {
  if (tracker.held) return { phase: "listening" };
  if (tracker.speaking !== null) {
    return { phase: "speaking", line: tracker.speaking };
  }
  return tracker.pending === null ? { phase: "idle" } : { phase: "thinking" };
}

// A line of the pending turn: its front call's line, or any later line of the same task (a failure line).
function ofPending(tracker: Tracker, spoken: Spoken): boolean {
  const { pending } = tracker;
  if (pending === null) return false;
  if (spoken.key !== null && spoken.key === pending.key) return true;
  return pending.taskId !== null && spoken.taskId === pending.taskId;
}

function endTurn(tracker: Tracker, key: UtteranceId): void {
  if (tracker.pending?.key === key) tracker.pending = null;
}

// A new hold silences every line, so an earlier turn's line will not speak.
function holdStarted(tracker: Tracker): void {
  tracker.held = true;
  tracker.pending = null;
}

function holdEnded(tracker: Tracker, accepted: UtteranceId | null): void {
  tracker.held = false;
  if (accepted !== null) tracker.pending = { key: accepted, taskId: null };
}

// Main's state starts a front call at once, so a turn still without a task had its words dropped.
function asked(tracker: Tracker, key: UtteranceId): void {
  if (tracker.pending?.taskId === null) endTurn(tracker, key);
}

function talkQueued(tracker: Tracker, spoken: Spoken): void {
  const { pending } = tracker;
  if (pending !== null && spoken.key === pending.key) {
    pending.taskId = spoken.taskId;
  }
}

function audioStarted(tracker: Tracker, spoken: Spoken, lineId: LineId) {
  if (ofPending(tracker, spoken)) tracker.pending = null;
  tracker.speaking = { lineId, taskId: spoken.taskId, kind: spoken.kind };
}

// A line of the turn that never spoke ends the turn; only the speaking line's own end clears Speaking.
function lineGone(tracker: Tracker, spoken: Spoken, lineId: LineId | null) {
  if (ofPending(tracker, spoken)) tracker.pending = null;
  if (lineId !== null && tracker.speaking?.lineId === lineId) {
    tracker.speaking = null;
  }
}

export function createPhaseTracker(
  send: (phase: VoicePhase) => void,
): PhaseTracker {
  const tracker: Tracker = { held: false, pending: null, speaking: null };
  let sent = JSON.stringify(phaseOf(tracker));
  // Only a change is sent.
  const after =
    <A extends unknown[]>(change: (t: Tracker, ...a: A) => void) =>
    (...args: A): void => {
      change(tracker, ...args);
      const phase = phaseOf(tracker);
      const text = JSON.stringify(phase);
      if (text === sent) return;
      sent = text;
      send(phase);
    };
  return {
    holdStarted: after(holdStarted),
    holdEnded: after(holdEnded),
    turnEnded: after(endTurn),
    asked: after(asked),
    talkQueued: after(talkQueued),
    audioStarted: after(audioStarted),
    lineGone: after(lineGone),
    reset: after((t) => {
      t.pending = null;
    }),
  };
}
