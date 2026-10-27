import { randomUUID } from "node:crypto";
import type { Transcription } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import type { Clip, RecordingCommand } from "../shared/ipc";
import type { HoldOutcome } from "./hold";

export type NotCaughtCause =
  | "empty"
  | "permissionDenied"
  | "noMicrophone"
  | "unreachable"
  | "keyRejected"
  | "noCredit"
  | "error";

// What one accepted utterance produced: a question's words, or why nothing was caught.
export type Heard =
  | { kind: "words"; utteranceId: UtteranceId; words: string }
  | { kind: "notCaught"; utteranceId: UtteranceId; cause: NotCaughtCause };

export type RecordingDeps = {
  sendRecording: (command: RecordingCommand) => void;
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<Transcription>;
  onHeard: (heard: Heard) => void;
};

type RecordingFlow = {
  holdStarted(): void;
  holdEnded(outcome: HoldOutcome): void;
  clipArrived(clip: Clip): void;
  rendererReset(): void;
};

type RecordingState = {
  recording: { utteranceId: UtteranceId; seq: number } | null;
  outcomes: Map<UtteranceId, { seq: number; outcome: HoldOutcome }>;
  nextSeq: number;
  lastWordsSeq: number;
};

type RecordedClip = Extract<Clip, { outcome: "recorded" }>;

function notCaught(
  utteranceId: UtteranceId,
  cause: NotCaughtCause,
  detail: string,
): Heard {
  console.log(`[Voice] not caught: ${cause} ${detail}`);
  return { kind: "notCaught", utteranceId, cause };
}

function heardFrom(utteranceId: UtteranceId, result: Transcription): Heard {
  switch (result.kind) {
    case "words":
      return { kind: "words", utteranceId, words: result.words };
    case "empty":
      return notCaught(utteranceId, "empty", "");
    case "failed":
      return notCaught(utteranceId, result.cause, result.detail);
  }
}

function deliver(
  state: RecordingState,
  deps: RecordingDeps,
  seq: number,
  heard: Heard,
): void {
  if (seq < state.lastWordsSeq) {
    console.log("[Voice] late transcript dropped");
    return;
  }
  if (heard.kind === "words") state.lastWordsSeq = seq;
  deps.onHeard(heard);
}

function endHold(
  state: RecordingState,
  deps: RecordingDeps,
  outcome: HoldOutcome,
): void {
  const recording = state.recording;
  if (recording === null) return;
  state.outcomes.set(recording.utteranceId, { seq: recording.seq, outcome });
  deps.sendRecording({ type: "stop", utteranceId: recording.utteranceId });
  state.recording = null;
}

function startHold(state: RecordingState, deps: RecordingDeps): void {
  if (state.recording !== null) endHold(state, deps, "discard");
  const utteranceId = randomUUID();
  state.recording = { utteranceId, seq: state.nextSeq };
  state.nextSeq += 1;
  deps.sendRecording({ type: "start", utteranceId });
}

async function transcribeOnce(
  state: RecordingState,
  deps: RecordingDeps,
  clip: RecordedClip,
  seq: number,
): Promise<void> {
  const startedAt = performance.now();
  let heard: Heard;
  try {
    const result = await deps.transcribe(clip.audio, clip.mimeType);
    const elapsed = Math.round(performance.now() - startedAt);
    console.log(`[Voice] transcript in ${elapsed} ms`);
    heard = heardFrom(clip.utteranceId, result);
  } catch (error) {
    heard = notCaught(clip.utteranceId, "error", String(error));
  }
  deliver(state, deps, seq, heard);
}

function receiveClip(
  state: RecordingState,
  deps: RecordingDeps,
  clip: Clip,
): void {
  const remembered = state.outcomes.get(clip.utteranceId);
  if (remembered === undefined) return;
  state.outcomes.delete(clip.utteranceId);
  const { seq, outcome } = remembered;
  if (outcome === "discard") {
    console.log("[Voice] clip dropped: discarded");
    return;
  }
  if (clip.outcome === "failed") {
    deliver(state, deps, seq, notCaught(clip.utteranceId, clip.reason, ""));
    return;
  }
  if (clip.audio.byteLength === 0) {
    deliver(state, deps, seq, notCaught(clip.utteranceId, "empty", "0 bytes"));
    return;
  }
  transcribeOnce(state, deps, clip, seq).catch((error: unknown) => {
    console.error("[Voice] delivering the transcript failed:", error);
  });
}

function forgetRenderer(state: RecordingState): void {
  state.recording = null;
  state.outcomes.clear();
}

export function createRecording(deps: RecordingDeps): RecordingFlow {
  const state: RecordingState = {
    recording: null,
    outcomes: new Map(),
    nextSeq: 1,
    lastWordsSeq: 0,
  };
  return {
    holdStarted: () => startHold(state, deps),
    holdEnded: (outcome) => endHold(state, deps, outcome),
    clipArrived: (clip) => receiveClip(state, deps, clip),
    rendererReset: () => forgetRenderer(state),
  };
}
