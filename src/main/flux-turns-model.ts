import type { Transcription } from "../providers/deepgram";
import type { Flux, FluxListener } from "../providers/flux";
import { wavFromPcm } from "../providers/wav";
import type { UtteranceId } from "../shared/cards";
import type { Timers } from "./tasks/state";

export type TurnsDeps = {
  startFlux: (listener: FluxListener) => Flux | null; // null when there is no Deepgram key
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<Transcription>;
  timers: Timers;
  log: (message: string) => void;
  onResult: (utteranceId: UtteranceId, result: Transcription) => void;
};

// One held utterance; its whole PCM stays until it resolves, so the batch call can still take it.
export type Utterance = {
  id: UtteranceId;
  frames: ArrayBuffer[];
  bytes: number;
  sentFrames: number;
  onSocket: boolean;
  ended: boolean;
  forced: boolean;
  batch: "no" | "marked" | "sent";
  done: boolean;
  byDeadline: boolean; // resolved by the deadline before its final came
  kept: string[];
  update: string;
  cancelDeadline: () => void;
};

export type State = {
  deps: TurnsDeps;
  flux: Flux | null;
  byId: Map<UtteranceId, Utterance>;
  sending: Utterance[]; // in key-down order; the first one owns the socket until its ForceEndTurn
  awaiting: Utterance[]; // on the current socket, in the order their audio was sent
};

const sampleRate = 16_000;
export const deadlineMs = 2000;
// An utterance bound for batch waits for its end marker until about 5 s after release.
export const batchWaitMs = 3000;
// The 90 s hold cap is about 2.9 MB; frames past this bound are dropped.
export const pcmLimitBytes = 96 * sampleRate * 2;

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

export function joined(texts: string[]): string {
  return texts
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join(" ");
}

export function transcription(text: string): Transcription {
  return text === "" ? { kind: "empty" } : { kind: "words", words: text };
}

export function finish(state: State, utterance: Utterance): void {
  utterance.done = true;
  utterance.cancelDeadline();
  utterance.frames = [];
  state.byId.delete(utterance.id);
}

export function deliver(
  state: State,
  utterance: Utterance,
  result: Transcription,
) {
  if (utterance.done) {
    state.deps.log("transcript dropped: its hold already ended");
    return;
  }
  finish(state, utterance);
  state.deps.onResult(utterance.id, result);
}

// An utterance that resolved before its ForceEndTurn still ends its Flux turn, so turns never mix.
export function abandon(state: State, utterance: Utterance): void {
  state.sending = state.sending.filter((other) => other !== utterance);
  if (!utterance.onSocket || utterance.forced) return;
  utterance.forced = true;
  state.flux?.endTurn();
}

export function startBatch(state: State, utterance: Utterance): void {
  if (utterance.done || utterance.batch === "sent") return;
  abandon(state, utterance);
  utterance.batch = "sent";
  utterance.cancelDeadline();
  const pcm = new Uint8Array(utterance.bytes);
  let offset = 0;
  for (const frame of utterance.frames) {
    pcm.set(new Uint8Array(frame), offset);
    offset += frame.byteLength;
  }
  if (pcm.byteLength === 0) return deliver(state, utterance, { kind: "empty" });
  state.deps.log(`batch transcription of ${pcm.byteLength} bytes`);
  const wav = wavFromPcm(pcm, sampleRate);
  // Wrapped so a synchronous throw takes the same path as a rejection.
  new Promise<Transcription>((resolve) =>
    resolve(state.deps.transcribe(wav, "audio/wav")),
  )
    .catch((error: unknown) => ({
      kind: "failed" as const,
      cause: "error" as const,
      detail: describeError(error),
    }))
    .then((result) => deliver(state, utterance, result))
    .catch((error: unknown) => {
      state.deps.log(`delivering a batch transcript failed: ${String(error)}`);
    });
}
