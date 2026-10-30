import type { Transcription } from "../providers/deepgram";
import type { Flux, FluxEvent, FluxListener } from "../providers/flux";
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
type Utterance = {
  id: UtteranceId;
  frames: ArrayBuffer[];
  bytes: number;
  sentFrames: number;
  onSocket: boolean;
  ended: boolean;
  forced: boolean;
  batch: "no" | "marked" | "sent";
  done: boolean;
  kept: string[];
  update: string;
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

function transcription(text: string): Transcription {
  return text === "" ? { kind: "empty" } : { kind: "words", words: text };
}

function finish(state: State, utterance: Utterance): void {
  utterance.done = true;
  utterance.cancelDeadline();
  utterance.frames = [];
  state.byId.delete(utterance.id);
}

function deliver(state: State, utterance: Utterance, result: Transcription) {
  if (utterance.done) {
    state.deps.log("transcript dropped: its hold already ended");
    return;
  }
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
    .then((result) => deliver(state, utterance, result))
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
    // A resolved or dropped utterance still waiting for its final could bind it to this audio's turn.
    const unsent = head.sentFrames < head.frames.length;
    const missing = state.awaiting.some((other) => other.done);
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

function resolveLatest(state: State, utterance: Utterance): void {
  state.deps.log("final transcript deadline passed; the latest update is used");
  const text = joined([...utterance.kept, utterance.update]);
  deliver(state, utterance, transcription(text));
  abandon(state, utterance);
  pump(state);
}

// At the cap the utterance goes to batch with the PCM it has; with none it is not caught.
function batchWaitPassed(state: State, utterance: Utterance): void {
  if (utterance.done || utterance.batch === "sent") return;
  if (utterance.batch === "no" && utterance.onSocket) {
    return resolveLatest(state, utterance);
  }
  state.deps.log("no end of frames by the cap; the utterance goes to batch");
  utterance.ended = true;
  startBatch(state, utterance);
}

// An utterance bound for batch, or whose socket is not open, is never resolved empty here: it waits for its frames.
function deadlinePassed(state: State, utterance: Utterance): void {
  if (utterance.done || utterance.batch === "sent") return;
  const open = state.flux?.isOpen() ?? false;
  if (utterance.batch === "no" && open) return resolveLatest(state, utterance);
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

function heard(state: State, event: FluxEvent): void {
  const head = state.awaiting[0];
  if (event.kind === "other") return state.deps.log(`flux: ${event.summary}`);
  if (head === undefined) return state.deps.log(`flux ${event.kind}: no turn`);
  if (event.kind === "update") {
    head.update = event.transcript;
    return;
  }
  // A timeout ends Flux's turn inside one long hold; its words wait for the rest of that hold.
  if (event.kind === "endOfTurn" && event.trigger === "timeout") {
    head.kept.push(event.transcript);
    head.update = "";
    return;
  }
  state.awaiting.shift();
  if (head.done) return state.deps.log(`late flux ${event.kind} dropped`);
  const last = event.kind === "endOfTurn" ? event.transcript : "";
  deliver(state, head, transcription(joined([...head.kept, last])));
}

// Results that came over the closed socket are dropped; an utterance whose frames went over it goes to batch.
function socketClosed(state: State): void {
  const lost = state.awaiting;
  state.awaiting = [];
  for (const utterance of lost) {
    utterance.onSocket = false;
    if (utterance.done) continue;
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
    sentFrames: 0,
    onSocket: false,
    ended: false,
    forced: false,
    batch: "no",
    done: false,
    kept: [],
    update: "",
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
