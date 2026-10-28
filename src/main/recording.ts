import { randomUUID } from "node:crypto";
import type { Transcription } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import type { MicAudio, MicFailure, RecordingCommand } from "../shared/ipc";
import { createTurns } from "./flux-turns";
import type { TurnsDeps } from "./flux-turns";
import type { HoldOutcome } from "./hold";

export type NotCaughtCause =
  "empty" | MicFailure | "unreachable" | "keyRejected" | "noCredit";

// What one accepted utterance produced: a question's words, or why nothing was caught.
export type Heard =
  | { kind: "words"; utteranceId: UtteranceId; words: string }
  | { kind: "notCaught"; utteranceId: UtteranceId; cause: NotCaughtCause };

export type RecordingDeps = Omit<TurnsDeps, "onResult"> & {
  sendRecording: (command: RecordingCommand) => void;
  onHeard: (heard: Heard) => void;
};

type RecordingFlow = {
  holdStarted(): void;
  holdEnded(outcome: HoldOutcome): void;
  micAudio(audio: MicAudio): void;
  rendererReset(): void;
  stop(): void;
};

type RecordingState = {
  recording: { utteranceId: UtteranceId; seq: number } | null;
  accepted: Map<UtteranceId, number>; // an accepted utterance's place in hold order, until it is heard
  nextSeq: number;
  lastWordsSeq: number;
};

// An utterance that never resolves (a lost renderer message) must not keep its place forever.
const acceptedLimit = 16;

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
  heard: Heard,
): void {
  const seq = state.accepted.get(heard.utteranceId);
  if (seq === undefined) {
    deps.log(`${heard.kind} dropped: not an accepted hold`);
    return;
  }
  state.accepted.delete(heard.utteranceId);
  if (seq < state.lastWordsSeq) {
    console.log("[Voice] late transcript dropped");
    return;
  }
  if (heard.kind === "words") state.lastWordsSeq = seq;
  deps.onHeard(heard);
}

function accept(state: RecordingState, utteranceId: UtteranceId, seq: number) {
  state.accepted.set(utteranceId, seq);
  if (state.accepted.size <= acceptedLimit) return;
  const oldest = state.accepted.keys().next();
  if (oldest.done !== true) state.accepted.delete(oldest.value);
}

type Turns = ReturnType<typeof createTurns>;

function endHold(
  state: RecordingState,
  deps: RecordingDeps,
  turns: Turns,
  outcome: HoldOutcome,
): void {
  const recording = state.recording;
  if (recording === null) return;
  state.recording = null;
  const { utteranceId, seq } = recording;
  deps.sendRecording({ type: "stop", utteranceId });
  if (outcome === "discard") return turns.drop(utteranceId);
  accept(state, utteranceId, seq);
  turns.released(utteranceId);
}

function receive(
  state: RecordingState,
  deps: RecordingDeps,
  turns: Turns,
  audio: MicAudio,
): void {
  const { utteranceId } = audio;
  if (audio.type === "frames") return turns.frames(utteranceId, audio.pcm);
  if (audio.type === "end") return turns.ended(utteranceId);
  turns.drop(utteranceId);
  deliver(state, deps, notCaught(utteranceId, audio.reason, ""));
}

export function createRecording(deps: RecordingDeps): RecordingFlow {
  const state: RecordingState = {
    recording: null,
    accepted: new Map(),
    nextSeq: 1,
    lastWordsSeq: 0,
  };
  const turns = createTurns({
    ...deps,
    onResult: (utteranceId, result) =>
      deliver(state, deps, heardFrom(utteranceId, result)),
  });
  return {
    holdStarted: () => {
      if (state.recording !== null) endHold(state, deps, turns, "discard");
      const utteranceId = randomUUID();
      state.recording = { utteranceId, seq: state.nextSeq };
      state.nextSeq += 1;
      turns.begin(utteranceId);
      deps.sendRecording({ type: "start", utteranceId });
    },
    holdEnded: (outcome) => endHold(state, deps, turns, outcome),
    micAudio: (audio) => receive(state, deps, turns, audio),
    rendererReset: () => {
      state.recording = null;
      state.accepted.clear();
      turns.reset();
    },
    stop: () => {
      endHold(state, deps, turns, "discard");
      state.accepted.clear();
      turns.stop();
    },
  };
}
