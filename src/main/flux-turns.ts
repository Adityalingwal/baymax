import type { Flux, FluxEvent } from "../providers/flux";
import type { UtteranceId } from "../shared/cards";
import {
  abandon,
  batchWaitMs,
  deadlineMs,
  deliver,
  finish,
  joined,
  pcmLimitBytes,
  startBatch,
  transcription,
} from "./flux-turns-model";
import type { State, TurnsDeps, Utterance } from "./flux-turns-model";

export type { TurnsDeps } from "./flux-turns-model";

export type Turns = {
  begin: (utteranceId: UtteranceId) => void;
  frames: (utteranceId: UtteranceId, pcm: ArrayBuffer) => void;
  ended: (utteranceId: UtteranceId) => void;
  released: (utteranceId: UtteranceId) => void;
  drop: (utteranceId: UtteranceId) => void;
  reset: () => void;
  stop: () => void;
};

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
    if (!sendFrames(state, flux, head) || !head.ended) return;
    state.sending.shift();
    head.forced = true;
    if (!flux.endTurn()) return;
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
  utterance.byDeadline = true;
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
    byDeadline: false,
    kept: [],
    update: "",
    cancelDeadline: () => undefined,
  };
  // An earlier utterance resolved by its deadline whose final never came would shift every later final: start a fresh socket.
  if (state.flux !== null && state.awaiting.some((other) => other.byDeadline)) {
    state.deps.log("an earlier final never came; the Flux socket restarts");
    state.flux.restart();
  }
  state.byId.set(id, utterance);
  state.sending.push(utterance);
  if (state.flux !== null && !state.flux.isOpen()) state.flux.connectNow();
}

function forEachLive(state: State, call: (utterance: Utterance) => void) {
  for (const utterance of [...state.byId.values()]) call(utterance);
}

// Binds Flux's turns to held utterances, with the deadline and the batch fallback.
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
