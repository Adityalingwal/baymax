import { randomUUID } from "node:crypto";
import { auraSampleRate } from "../providers/aura";
import type { Aura, AuraEvent, AuraListener } from "../providers/aura";
import type { Synthesis } from "../providers/deepgram";
import type { TaskId } from "../shared/cards";
import type {
  LineId,
  PlaybackFinished,
  SpeechChunk,
  SpeechEnd,
  SpeechLine,
  StopPlayback,
} from "../shared/ipc";
import { takeClauses } from "./clauses";
import type { SaidKind, SaidLine, Timers } from "./tasks/state";

export type VoiceDownCause = "unreachable" | "keyRejected" | "noCredit";

export type Spoken = Pick<Line, "taskId" | "kind" | "key">;

// A line the talker writes as its reply streams in; end() closes it, cut() drops it wherever it is.
export type LineFeed = {
  push: (text: string) => void;
  end: () => void;
  cut: () => void;
};

type SpeechDeps = {
  synthesize: (text: string, signal: AbortSignal) => Promise<Synthesis>;
  startAura: (listener: AuraListener) => Aura | null; // null when there is no Deepgram key
  sendSpeech: (line: SpeechLine) => void;
  sendChunk: (chunk: SpeechChunk) => void;
  sendEnd: (end: SpeechEnd) => void;
  sendStop: (payload: StopPlayback) => void;
  onVoiceAvailable: (available: boolean, cause: VoiceDownCause | null) => void; // only on a change
  onAudioStarted: (line: Spoken, lineId: LineId) => void; // a line's first audio reached the renderer
  onLineGone: (line: Spoken, lineId: LineId | null) => void; // once per line that leaves speech; lineId only if its audio started
  timers: Timers;
};

type LineText = {
  text: string;
  ended: boolean;
  changed: (() => void) | null;
};

// key: the generation (release or typed question) of a talker reply, else null.
type Line = {
  taskId: TaskId | null;
  kind: SaidKind;
  key: string | null;
  feed: LineText;
};

// A distinct object per synthesis, so a settled job can tell whether it still owns the slot.
type Job = { line: Line; abort: AbortController };

// A line on the Aura socket while its text and audio still flow; seq numbers its chunks.
type StreamJob = {
  seq: number;
  taken: number; // characters of the line's text already cut into clauses
  flushesSent: number;
  flushesDone: number;
  spokeSinceFlush: boolean;
  textEnded: boolean;
};

// The line that owns playback until the renderer reports its end; started tells whether its audio began.
type Playing = {
  lineId: LineId;
  line: Line;
  cancelDeadline: () => void;
  stream: StreamJob | null;
  started: boolean; // its first audio reached the renderer
};

type SpeechState = {
  pending: Line[];
  synthesizing: Job | null;
  playing: Playing | null;
  held: boolean;
  muted: boolean;
  cancelled: Set<TaskId>;
  voiceAvailable: boolean;
};

type SpeechContext = {
  state: SpeechState;
  deps: SpeechDeps;
  aura: Aura | null;
};

type Matches = (line: Spoken) => boolean;

type Speech = {
  speak(line: SaidLine): void;
  speakFed(spoken: Spoken): LineFeed;
  holdStarted(): void;
  holdEnded(): void;
  setMuted(muted: boolean): void;
  cancelTask(taskId: TaskId): void;
  playbackFinished(payload: PlaybackFinished): void;
  rendererReset(): void;
};

type Audio = Extract<Synthesis, { kind: "audio" }>;
type Failed = Extract<Synthesis, { kind: "failed" }>;

// A renderer that never reports must not block speech forever.
const playbackDeadlineMs = 60_000;
const cancelledLimit = 64;
const everyLine: Matches = () => true;

function log(message: string): void {
  console.log(`[Speech] ${message}`);
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

// An injected callback that throws is logged; it never breaks the speech state.
function guarded(name: string, call: () => void): boolean {
  try {
    call();
    return true;
  } catch (error) {
    log(`${name} threw: ${describeError(error)}`);
    return false;
  }
}

// A line that leaves speech, played or not; every drop and every end of playback comes through here once.
function lineGone(ctx: SpeechContext, line: Line, lineId: LineId | null): void {
  guarded("onLineGone", () => ctx.deps.onLineGone(line, lineId));
}

function audioStarted(ctx: SpeechContext, playing: Playing): void {
  if (playing.started) return;
  playing.started = true;
  const { line, lineId } = playing;
  guarded("onAudioStarted", () => ctx.deps.onAudioStarted(line, lineId));
}

function stopInRenderer(ctx: SpeechContext, lineId: LineId): void {
  guarded("sendStop", () => ctx.deps.sendStop({ lineId }));
}

function endInRenderer(ctx: SpeechContext, lineId: LineId): void {
  guarded("sendEnd", () => ctx.deps.sendEnd({ lineId }));
}

function voiceBack(ctx: SpeechContext): void {
  if (ctx.state.voiceAvailable) return;
  ctx.state.voiceAvailable = true;
  log("voice back");
  guarded("onVoiceAvailable", () => ctx.deps.onVoiceAvailable(true, null));
}

// Gives the line the playback slot with its deadline; without a deadline a lost report could block speech for good.
function occupy(
  ctx: SpeechContext,
  line: Line,
  stream: StreamJob | null,
): Playing | null {
  const lineId = randomUUID();
  let cancelDeadline = (): void => undefined;
  const timed = guarded("setTimer", () => {
    cancelDeadline = ctx.deps.timers.setTimer(playbackDeadlineMs, () =>
      deadlinePassed(ctx, lineId),
    );
  });
  if (!timed) {
    lineGone(ctx, line, null);
    return null;
  }
  ctx.state.playing = { lineId, line, cancelDeadline, stream, started: false };
  return ctx.state.playing;
}

function deadlinePassed(ctx: SpeechContext, lineId: LineId): void {
  if (!endPlaying(ctx, lineId)) return;
  log("playback timeout: the renderer never reported the line's end");
  stopInRenderer(ctx, lineId);
  pump(ctx);
}

// A stream cut before its audio ended restarts the socket, so none of its audio reaches the next line.
// moving: the line only changes path (socket to REST), so it has not left speech.
function endPlaying(
  ctx: SpeechContext,
  lineId: LineId,
  moving = false,
): boolean {
  const playing = ctx.state.playing;
  if (playing === null || playing.lineId !== lineId) return false;
  ctx.state.playing = null;
  guarded("cancelDeadline", playing.cancelDeadline);
  if (playing.stream !== null) guarded("restart", () => ctx.aura?.restart());
  if (!moving) lineGone(ctx, playing.line, playing.started ? lineId : null);
  return true;
}

function stopPlaying(
  ctx: SpeechContext,
  matches: Matches,
  sendStop: boolean,
): void {
  const playing = ctx.state.playing;
  if (playing === null || !matches(playing.line)) return;
  endPlaying(ctx, playing.lineId);
  if (sendStop) stopInRenderer(ctx, playing.lineId);
}

function startPlaying(ctx: SpeechContext, line: Line, result: Audio) {
  const playing = occupy(ctx, line, null);
  if (playing === null) return pump(ctx);
  const { lineId } = playing;
  const { audio, mimeType } = result;
  const sent = guarded("sendSpeech", () =>
    ctx.deps.sendSpeech({ lineId, audio, mimeType }),
  );
  if (!sent && endPlaying(ctx, lineId)) return pump(ctx);
  audioStarted(ctx, playing);
}

function synthesisFailed(ctx: SpeechContext, failure: Failed): void {
  if (failure.cause === "error") {
    log(`line dropped: synthesis error ${failure.detail}`);
    return;
  }
  const cause = failure.cause;
  log(`line dropped: voice down (${cause}) ${failure.detail}`);
  if (!ctx.state.voiceAvailable) return;
  ctx.state.voiceAvailable = false;
  guarded("onVoiceAvailable", () => ctx.deps.onVoiceAvailable(false, cause));
}

function synthesisSettled(
  ctx: SpeechContext,
  job: Job,
  result: Synthesis,
  startedAt: number,
): void {
  if (ctx.state.synthesizing !== job) return;
  ctx.state.synthesizing = null;
  log(`synthesis in ${Math.round(performance.now() - startedAt)} ms`);
  if (result.kind === "failed") {
    synthesisFailed(ctx, result);
    lineGone(ctx, job.line, null);
    pump(ctx);
    return;
  }
  startPlaying(ctx, job.line, result);
  voiceBack(ctx);
}

function synthesize(ctx: SpeechContext, job: Job): void {
  const { line } = job;
  line.feed.changed = null;
  if (line.feed.text.trim() === "") {
    ctx.state.synthesizing = null;
    log(`line dropped: no text (${line.kind})`);
    lineGone(ctx, line, null);
    return pump(ctx);
  }
  const startedAt = performance.now();
  const settle = (result: Synthesis) =>
    synthesisSettled(ctx, job, result, startedAt);
  // Wrapped so a synchronous throw takes the same path as a rejection.
  new Promise<Synthesis>((resolve) =>
    resolve(ctx.deps.synthesize(line.feed.text, job.abort.signal)),
  )
    .then(settle, (error: unknown) =>
      settle({ kind: "failed", cause: "error", detail: describeError(error) }),
    )
    .catch((error: unknown) => {
      log(`settling a synthesis threw: ${describeError(error)}`);
    });
}

function startRest(ctx: SpeechContext, line: Line): void {
  const job: Job = { line, abort: new AbortController() };
  ctx.state.synthesizing = job;
  if (line.feed.ended) return synthesize(ctx, job);
  // A line still being written holds the slot until its text has ended.
  line.feed.changed = () => {
    if (ctx.state.synthesizing === job && line.feed.ended) synthesize(ctx, job);
  };
}

// Every send is checked; false means the socket failed and the line takes the socket-failure path.
function sendClauses(
  aura: Aura,
  stream: StreamJob,
  clauses: string[],
): boolean {
  for (const clause of clauses) {
    if (!aura.speak(clause)) return false;
    stream.spokeSinceFlush = true;
    // The first clause is flushed at once, so its audio starts while the rest is written.
    if (stream.flushesSent === 0 && !flush(aura, stream)) return false;
  }
  return true;
}

function flush(aura: Aura, stream: StreamJob): boolean {
  stream.flushesSent += 1;
  stream.spokeSinceFlush = false;
  return aura.flush();
}

// Text goes out clause by clause as it arrives; Flush only after the first clause and at the end, at most two per line.
function sendText(aura: Aura, stream: StreamJob, line: Line): boolean {
  const { text, ended } = line.feed;
  const { clauses, rest } = takeClauses(text.slice(stream.taken), ended);
  stream.taken = text.length - rest.length;
  if (!sendClauses(aura, stream, clauses)) return false;
  if (!ended) return true;
  stream.textEnded = true;
  line.feed.changed = null;
  return !stream.spokeSinceFlush || flush(aura, stream);
}

function audioDone(ctx: SpeechContext): void {
  const playing = ctx.state.playing;
  const stream = playing?.stream ?? null;
  if (playing === null || stream === null) return;
  if (!stream.textEnded || stream.flushesDone < stream.flushesSent) return;
  playing.stream = null;
  endInRenderer(ctx, playing.lineId);
}

function startStream(ctx: SpeechContext, aura: Aura, line: Line): void {
  const stream: StreamJob = {
    seq: 0,
    taken: 0,
    flushesSent: 0,
    flushesDone: 0,
    spokeSinceFlush: false,
    textEnded: false,
  };
  if (occupy(ctx, line, stream) === null) return pump(ctx);
  const next = () => {
    if (ctx.state.playing?.stream !== stream) return;
    if (!sendText(aura, stream, line)) return sendFailed(ctx, aura);
    audioDone(ctx);
  };
  line.feed.changed = next;
  next();
}

// Chunks and Flushed carry no line id, so they belong to the line streaming now.
function auraHeard(ctx: SpeechContext, event: AuraEvent): void {
  const playing = ctx.state.playing;
  const stream = playing?.stream ?? null;
  if (event.kind === "other") return log(`speech socket: ${event.summary}`);
  if (playing === null || stream === null) {
    return log(`speech socket ${event.kind} dropped: no line streaming`);
  }
  if (event.kind === "flushed") {
    stream.flushesDone += 1;
    return audioDone(ctx);
  }
  const { lineId } = playing;
  const chunk = { lineId, seq: stream.seq, pcm: event.pcm };
  stream.seq += 1;
  guarded("sendChunk", () =>
    ctx.deps.sendChunk({ ...chunk, sampleRate: auraSampleRate }),
  );
  if (chunk.seq === 0) audioStarted(ctx, playing);
  voiceBack(ctx);
}

// A failed send restarts the socket like a cut line, so no event of the old socket binds to a later line.
function sendFailed(ctx: SpeechContext, aura: Aura): void {
  log("a speech socket send failed; the socket restarts");
  aura.restart();
  // The restart's close already ran the line's fallback if the socket was open; otherwise it runs here.
  auraClosed(ctx);
}

// A line that had no audio yet goes to REST whole; one that had some ends where it is, never replayed.
function auraClosed(ctx: SpeechContext): void {
  const playing = ctx.state.playing;
  const stream = playing?.stream ?? null;
  if (playing === null || stream === null) return;
  playing.stream = null;
  const { lineId, line } = playing;
  if (stream.seq > 0) {
    log("speech socket closed mid-line: the rest of the line is dropped");
    endInRenderer(ctx, lineId);
    return;
  }
  log("speech socket closed before any audio: the line goes to REST");
  endPlaying(ctx, lineId, true);
  startRest(ctx, line);
}

function dropPending(ctx: SpeechContext, matches: Matches, why: string): void {
  const { state } = ctx;
  const dropped = state.pending.filter(matches);
  state.pending = state.pending.filter((line) => !matches(line));
  if (dropped.length > 0)
    log(`${dropped.length} pending line(s) dropped: ${why}`);
  dropped.forEach((line) => lineGone(ctx, line, null));
}

function dropSynthesis(ctx: SpeechContext, matches: Matches, why: string) {
  const job = ctx.state.synthesizing;
  if (job === null || !matches(job.line)) return;
  ctx.state.synthesizing = null;
  log(`line dropped while synthesizing: ${why}`);
  job.abort.abort();
  lineGone(ctx, job.line, null);
}

function clearSpeech(
  ctx: SpeechContext,
  clear: { matches: Matches; why: string; sendStop: boolean },
): void {
  dropPending(ctx, clear.matches, clear.why);
  dropSynthesis(ctx, clear.matches, clear.why);
  stopPlaying(ctx, clear.matches, clear.sendStop);
}

// The open Aura socket streams the line; without it the line goes to the REST call.
function pump(ctx: SpeechContext): void {
  const { state, aura } = ctx;
  if (state.held || state.muted) return;
  if (state.synthesizing !== null || state.playing !== null) return;
  let line = state.pending[0];
  // A talker line that ended with no words has nothing to say.
  while (
    line !== undefined &&
    line.feed.ended &&
    line.feed.text.trim() === ""
  ) {
    log(`line dropped: no text (${line.kind})`);
    state.pending.shift();
    lineGone(ctx, line, null);
    line = state.pending[0];
  }
  // A talker line waits at the head of the queue until its first words arrive.
  if (line === undefined || line.feed.text === "") return;
  state.pending.shift();
  if (aura !== null && aura.isOpen()) startStream(ctx, aura, line);
  else startRest(ctx, line);
}

function queueLine(ctx: SpeechContext, line: Line): void {
  const { state } = ctx;
  const taskId = line.taskId;
  const why = state.muted
    ? "muted"
    : taskId !== null && state.cancelled.has(taskId)
      ? "task cancelled"
      : null;
  if (why !== null) {
    log(`line dropped: ${why} (${line.kind})`);
    return lineGone(ctx, line, null);
  }
  state.pending.push(line);
  pump(ctx);
}

function speakFed(ctx: SpeechContext, spoken: Spoken): LineFeed {
  const line: Line = {
    ...spoken,
    feed: { text: "", ended: false, changed: () => pump(ctx) },
  };
  queueLine(ctx, line);
  const changed = () => line.feed.changed?.();
  return {
    push: (text) => {
      if (line.feed.ended || text === "") return;
      line.feed.text += text;
      changed();
    },
    end: () => {
      if (line.feed.ended) return;
      line.feed.ended = true;
      changed();
    },
    cut: () => {
      line.feed.ended = true;
      line.feed.changed = null;
      const matches: Matches = (other) => other === line;
      clearSpeech(ctx, { matches, why: "line cut", sendStop: true });
      pump(ctx);
    },
  };
}

function startHold(ctx: SpeechContext): void {
  ctx.state.held = true;
  clearSpeech(ctx, { matches: everyLine, why: "key pressed", sendStop: true });
}

function endHold(ctx: SpeechContext): void {
  if (!ctx.state.held) return;
  ctx.state.held = false;
  pump(ctx);
}

function changeMuted(ctx: SpeechContext, muted: boolean): void {
  if (ctx.state.muted === muted) return;
  ctx.state.muted = muted;
  if (muted) {
    clearSpeech(ctx, { matches: everyLine, why: "muted", sendStop: true });
  }
  pump(ctx);
}

function cancelLines(ctx: SpeechContext, taskId: TaskId): void {
  const { cancelled } = ctx.state;
  cancelled.add(taskId);
  // Only recent cancels can still meet a late line, so the set keeps the latest ones.
  if (cancelled.size > cancelledLimit) {
    const oldest = cancelled.values().next();
    if (oldest.done !== true) cancelled.delete(oldest.value);
  }
  const matches: Matches = (line) => line.taskId === taskId;
  clearSpeech(ctx, { matches, why: "task cancelled", sendStop: true });
  pump(ctx);
}

function finishPlayback(ctx: SpeechContext, payload: PlaybackFinished) {
  if (!endPlaying(ctx, payload.lineId)) return;
  if (payload.outcome === "failed") log("playback failed in the renderer");
  pump(ctx);
}

// The renderer and its key state are gone, so nothing is told to stop.
function forgetRenderer(ctx: SpeechContext): void {
  ctx.state.held = false;
  clearSpeech(ctx, {
    matches: everyLine,
    why: "renderer reset",
    sendStop: false,
  });
  pump(ctx);
}

export function createSpeech(deps: SpeechDeps): Speech {
  const ctx: SpeechContext = {
    state: {
      pending: [],
      synthesizing: null,
      playing: null,
      held: false,
      muted: false,
      cancelled: new Set(),
      voiceAvailable: true,
    },
    deps,
    aura: null,
  };
  ctx.aura = deps.startAura({
    heard: (event) => auraHeard(ctx, event),
    closed: () => auraClosed(ctx),
  });
  return {
    speak: ({ taskId, kind, text }) => {
      const feed = { text, ended: true, changed: null };
      queueLine(ctx, { taskId, kind, key: null, feed });
    },
    speakFed: (spoken) => speakFed(ctx, spoken),
    holdStarted: () => startHold(ctx),
    holdEnded: () => endHold(ctx),
    setMuted: (muted) => changeMuted(ctx, muted),
    cancelTask: (taskId) => cancelLines(ctx, taskId),
    playbackFinished: (payload) => finishPlayback(ctx, payload),
    rendererReset: () => forgetRenderer(ctx),
  };
}
