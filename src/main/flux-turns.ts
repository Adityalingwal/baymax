import type { Transcription } from "../providers/deepgram";
import type { Flux, FluxEvent, FluxListener } from "../providers/flux";
import { wavFromPcm } from "../providers/wav";
import type { UtteranceId } from "../shared/cards";
import type { Timers } from "./tasks/state";

// silent: a hold with audio but no speech, so nothing needs saying.
export type TurnResult = Transcription | { kind: "silent" };

export type TurnsDeps = {
  startFlux: (listener: FluxListener) => Flux | null; // null when there is no Deepgram key
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<Transcription>;
  timers: Timers;
  log: (message: string) => void;
  onResult: (utteranceId: UtteranceId, result: TurnResult) => void;
};

// One held utterance; its whole PCM stays until it resolves, so the batch call can still take it.
type Utterance = {
  id: UtteranceId;
  frames: ArrayBuffer[];
  bytes: number;
  peak: number; // the loudest sample so far, 0 to 1
  sentFrames: number;
  onSocket: boolean;
  ended: boolean;
  forced: boolean;
  batch: "no" | "marked" | "sent";
  done: boolean;
  kept: string[];
  cancelDeadline: () => void;
};

type State = {
  deps: TurnsDeps;
  flux: Flux | null;
  byId: Map<UtteranceId, Utterance>;
  sending: Utterance[]; // in key-down order; the first one owns the socket until its ForceEndTurn
  awaiting: Utterance[]; // on the current socket, in the order their audio was sent
};

type Turns = {
  begin: (utteranceId: UtteranceId) => void;
  frames: (utteranceId: UtteranceId, pcm: ArrayBuffer) => void;
  ended: (utteranceId: UtteranceId) => void;
  released: (utteranceId: UtteranceId) => void;
  drop: (utteranceId: UtteranceId) => void;
  reset: () => void;
  stop: () => void;
};

const sampleRate = 16_000;
const deadlineMs = 2000;
// An utterance bound for batch waits for its end marker until about 5 s after release.
const batchWaitMs = 3000;
// The 90 s hold cap is about 2.9 MB; frames past this bound are dropped.
const pcmLimitBytes = 96 * sampleRate * 2;
// Under this peak a hold counts as nothing said; measured on one Mac (silence 1-1.5%, a whisper 5%).
const speechPeak = 0.03;

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function joined(texts: string[]): string {
  return texts
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join(" ");
}

function peakOf(pcm: ArrayBuffer): number {
  const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2));
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak / 0x8000;
}

// What an empty transcript means for this hold; null when speech was lost.
function resultOfNothingHeard(utterance: Utterance): TurnResult | null {
  const kept = joined(utterance.kept);
  if (kept !== "") return { kind: "words", words: kept };
  return utterance.peak < speechPeak ? { kind: "silent" } : null;
}

function finish(state: State, utterance: Utterance): void {
  utterance.done = true;
  utterance.cancelDeadline();
  utterance.frames = [];
  state.byId.delete(utterance.id);
}

function deliver(state: State, utterance: Utterance, result: TurnResult) {
  if (utterance.done) {
    state.deps.log("transcript dropped: its hold already ended");
    return;
  }
  const peak = Math.round(utterance.peak * 100);
  const audioMs = Math.round((utterance.bytes / 2 / sampleRate) * 1000);
  state.deps.log(`hold level: peak ${peak}%, ${audioMs} ms of audio`);
  finish(state, utterance);
  state.deps.onResult(utterance.id, result);
}

// An utterance that resolved before its ForceEndTurn still ends its Flux turn, so turns never mix.
// A fresh socket: the listener's close marks every unresolved utterance on the old one for batch.
function restartSocket(state: State, why: string): void {
  const flux = state.flux;
  if (flux === null || !flux.isOpen()) return;
  state.deps.log(`the Flux socket restarts: ${why}`);
  flux.restart();
}

function abandon(state: State, utterance: Utterance): void {
  state.sending = state.sending.filter((other) => other !== utterance);
  if (!utterance.onSocket || utterance.forced) return;
  utterance.forced = true;
  if (state.flux?.endTurn() === false) {
    restartSocket(state, "a ForceEndTurn send failed");
  }
}

function startBatch(state: State, utterance: Utterance): void {
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
    .then((result) => {
      const empty = result.kind === "empty";
      const meant = empty ? resultOfNothingHeard(utterance) : null;
      deliver(state, utterance, meant ?? result);
    })
    .catch((error: unknown) => {
      state.deps.log(`delivering a batch transcript failed: ${String(error)}`);
    });
}

function sendFrames(state: State, flux: Flux, utterance: Utterance): boolean {
  while (utterance.sentFrames < utterance.frames.length) {
    const frame = utterance.frames[utterance.sentFrames];
    if (!flux.sendAudio(frame)) return false;
    utterance.sentFrames += 1;
    if (!utterance.onSocket) {
      utterance.onSocket = true;
      state.awaiting.push(utterance);
    }
  }
  return true;
}

// Sends what the socket may carry now: the oldest utterance's frames, and its ForceEndTurn once its frames ended.
function pump(state: State): void {
  const flux = state.flux;
  if (flux === null || !flux.isOpen()) return;
  for (let head = state.sending[0]; head; head = state.sending[0]) {
    if (head.done || head.batch !== "no") {
      abandon(state, head);
      continue;
    }
    // A resolved, dropped or batched utterance still waiting for its final could bind it to this audio's turn.
    const unsent = head.sentFrames < head.frames.length;
    const missing = state.awaiting.some(
      (other) => other.done || other.batch !== "no",
    );
    if (unsent && missing) {
      return restartSocket(state, "an earlier final is still missing");
    }
    if (!sendFrames(state, flux, head)) {
      return restartSocket(state, "an audio send failed");
    }
    if (!head.ended) return;
    state.sending.shift();
    head.forced = true;
    if (!flux.endTurn()) {
      return restartSocket(state, "a ForceEndTurn send failed");
    }
  }
}

function receiveFrames(state: State, id: UtteranceId, pcm: ArrayBuffer) {
  const utterance = state.byId.get(id);
  if (utterance === undefined || utterance.ended) return;
  if (utterance.bytes + pcm.byteLength > pcmLimitBytes) {
    state.deps.log("frames past the hold cap dropped");
    return;
  }
  utterance.frames.push(pcm);
  utterance.bytes += pcm.byteLength;
  utterance.peak = Math.max(utterance.peak, peakOf(pcm));
  if (utterance.batch === "no") pump(state);
}

function receiveEnd(state: State, id: UtteranceId): void {
  const utterance = state.byId.get(id);
  if (utterance === undefined || utterance.ended) return;
  utterance.ended = true;
  if (utterance.bytes === 0) {
    abandon(state, utterance);
    return deliver(state, utterance, { kind: "empty" });
  }
  const open = state.flux?.isOpen() ?? false;
  if (utterance.batch !== "no" || !open) return startBatch(state, utterance);
  pump(state);
}

// At the cap the utterance goes to batch with the PCM it has; with none it is not caught.
function batchWaitPassed(state: State, utterance: Utterance): void {
  if (utterance.done || utterance.batch === "sent") return;
  state.deps.log("no end of frames by the cap; the utterance goes to batch");
  utterance.ended = true;
  startBatch(state, utterance);
}

// A partial Update is never used, as it can be a question cut short. With every frame here batch starts and the
// first whole result wins. Otherwise batch waits for the later frames, and the socket restarts so no final comes
// from the audio it already has.
function deadlinePassed(state: State, utterance: Utterance): void {
  if (utterance.done || utterance.batch === "sent") return;
  state.deps.log("final transcript deadline passed");
  if (utterance.ended) {
    startBatch(state, utterance);
    return pump(state);
  }
  utterance.batch = "marked";
  if (utterance.onSocket) {
    restartSocket(state, "frames still pending at the deadline");
  }
  abandon(state, utterance);
  pump(state);
  utterance.cancelDeadline = state.deps.timers.setTimer(batchWaitMs, () =>
    batchWaitPassed(state, utterance),
  );
}

function release(state: State, id: UtteranceId): void {
  const utterance = state.byId.get(id);
  if (utterance === undefined || utterance.batch === "sent") return;
  utterance.cancelDeadline();
  utterance.cancelDeadline = state.deps.timers.setTimer(deadlineMs, () =>
    deadlinePassed(state, utterance),
  );
}

function dropUtterance(state: State, utterance: Utterance): void {
  finish(state, utterance);
  abandon(state, utterance);
}

// A hold's last turn event: its words, or the empty rule, where speech lost goes to batch.
function turnEnded(state: State, utterance: Utterance, last: string): void {
  const text = joined([...utterance.kept, last]);
  if (text !== "") {
    return deliver(state, utterance, { kind: "words", words: text });
  }
  const meant = resultOfNothingHeard(utterance);
  if (meant !== null) return deliver(state, utterance, meant);
  startBatch(state, utterance);
}

function heard(state: State, event: FluxEvent): void {
  const head = state.awaiting[0];
  if (event.kind === "other") return state.deps.log(`flux: ${event.summary}`);
  if (head === undefined) return state.deps.log(`flux ${event.kind}: no turn`);
  if (event.kind === "update") return;
  // A timeout ends Flux's turn inside one long hold; its words wait for the rest of that hold.
  if (event.kind === "endOfTurn" && event.trigger === "timeout") {
    head.kept.push(event.transcript);
    return;
  }
  state.awaiting.shift();
  // An ignored ForceEndTurn leaves this audio in Flux's open turn, where it would join the next hold's words.
  if (event.kind === "noActiveTurn" && head.peak >= speechPeak) {
    restartSocket(state, "a no-turn hold left its audio in the turn");
  }
  if (head.done) return state.deps.log(`late flux ${event.kind} dropped`);
  turnEnded(state, head, event.kind === "endOfTurn" ? event.transcript : "");
}

// Results that came over the closed socket are dropped; an utterance whose frames went over it goes to batch.
function socketClosed(state: State): void {
  const lost = state.awaiting;
  state.awaiting = [];
  for (const utterance of lost) {
    utterance.onSocket = false;
    if (utterance.done || utterance.batch === "sent") continue;
    utterance.batch = "marked";
    if (utterance.ended) startBatch(state, utterance);
  }
  state.sending = state.sending.filter((other) => other.batch === "no");
}

function begin(state: State, id: UtteranceId): void {
  const utterance: Utterance = {
    id,
    frames: [],
    bytes: 0,
    peak: 0,
    sentFrames: 0,
    onSocket: false,
    ended: false,
    forced: false,
    batch: "no",
    done: false,
    kept: [],
    cancelDeadline: () => undefined,
  };
  state.byId.set(id, utterance);
  state.sending.push(utterance);
  if (state.flux !== null && !state.flux.isOpen()) state.flux.connectNow();
}

function forEachLive(state: State, call: (utterance: Utterance) => void) {
  for (const utterance of [...state.byId.values()]) call(utterance);
}

export function createTurns(deps: TurnsDeps): Turns {
  const state: State = {
    deps,
    flux: null,
    byId: new Map(),
    sending: [],
    awaiting: [],
  };
  state.flux = deps.startFlux({
    opened: () => pump(state),
    heard: (event) => heard(state, event),
    closed: () => socketClosed(state),
  });
  const withUtterance =
    (call: (utterance: Utterance) => void) => (id: UtteranceId) => {
      const utterance = state.byId.get(id);
      if (utterance !== undefined) call(utterance);
    };
  return {
    begin: (id) => begin(state, id),
    frames: (id, pcm) => receiveFrames(state, id, pcm),
    ended: (id) => receiveEnd(state, id),
    released: (id) => release(state, id),
    drop: withUtterance((utterance) => {
      dropUtterance(state, utterance);
      pump(state);
    }),
    reset: () =>
      forEachLive(state, (utterance) => dropUtterance(state, utterance)),
    stop: () => {
      forEachLive(state, (utterance) => finish(state, utterance));
      state.flux?.stop();
    },
  };
}
