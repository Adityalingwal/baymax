import { randomUUID } from "node:crypto";
import type { Synthesis } from "../providers/deepgram";
import type { TaskId } from "../shared/cards";
import type {
  LineId,
  PlaybackFinished,
  SpeechLine,
  StopPlayback,
} from "../shared/ipc";
import type { SaidKind, SaidLine, Timers } from "./tasks/state";

export type VoiceDownCause = "unreachable" | "keyRejected" | "noCredit";

export type SpeechDeps = {
  synthesize: (text: string, signal: AbortSignal) => Promise<Synthesis>;
  sendSpeech: (line: SpeechLine) => void;
  sendStop: (payload: StopPlayback) => void;
  onVoiceAvailable: (available: boolean, cause: VoiceDownCause | null) => void; // only on a change
  timers: Timers;
};

type Speech = {
  speak(line: SaidLine): void;
  holdStarted(): void;
  holdEnded(): void;
  setMuted(muted: boolean): void;
  cancelTask(taskId: TaskId): void;
  playbackFinished(payload: PlaybackFinished): void;
  rendererReset(): void;
};

// A distinct object per synthesis, so a settled job can tell whether it still owns the slot.
type Job = { line: SaidLine; abort: AbortController };

type Playing = {
  lineId: LineId;
  taskId: TaskId | null;
  kind: SaidKind;
  cancelDeadline: () => void;
};

type SpeechState = {
  pending: SaidLine[];
  synthesizing: Job | null;
  playing: Playing | null;
  held: boolean;
  muted: boolean;
  cancelled: Set<TaskId>;
  voiceAvailable: boolean;
};

type Spoken = Pick<SaidLine, "taskId" | "kind">;
type Matches = (line: Spoken) => boolean;
type Audio = Extract<Synthesis, { kind: "audio" }>;
type Failed = Extract<Synthesis, { kind: "failed" }>;

// A renderer that never reports must not block speech forever.
const playbackDeadlineMs = 60_000;

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

function dropPending(state: SpeechState, matches: Matches, why: string): void {
  const kept = state.pending.filter((line) => !matches(line));
  const dropped = state.pending.length - kept.length;
  if (dropped > 0) log(`${dropped} pending line(s) dropped: ${why}`);
  state.pending = kept;
}

function dropSynthesis(state: SpeechState, matches: Matches, why: string) {
  const job = state.synthesizing;
  if (job === null || !matches(job.line)) return;
  state.synthesizing = null;
  log(`line dropped while synthesizing: ${why}`);
  job.abort.abort();
}

function endPlaying(state: SpeechState, lineId: LineId): boolean {
  const playing = state.playing;
  if (playing === null || playing.lineId !== lineId) return false;
  state.playing = null;
  playing.cancelDeadline();
  return true;
}

function stopPlaying(
  state: SpeechState,
  deps: SpeechDeps,
  matches: Matches,
  sendStop: boolean,
): void {
  const playing = state.playing;
  if (playing === null || !matches(playing)) return;
  endPlaying(state, playing.lineId);
  if (!sendStop) return;
  const lineId = playing.lineId;
  guarded("sendStop", () => deps.sendStop({ lineId }));
}

function clearSpeech(
  state: SpeechState,
  deps: SpeechDeps,
  clear: { matches: Matches; why: string; sendStop: boolean },
): void {
  dropPending(state, clear.matches, clear.why);
  dropSynthesis(state, clear.matches, clear.why);
  stopPlaying(state, deps, clear.matches, clear.sendStop);
}

function deadlinePassed(
  state: SpeechState,
  deps: SpeechDeps,
  lineId: LineId,
): void {
  if (!endPlaying(state, lineId)) return;
  log("playback timeout: the renderer never reported the line's end");
  guarded("sendStop", () => deps.sendStop({ lineId }));
  pump(state, deps);
}

function startPlaying(
  state: SpeechState,
  deps: SpeechDeps,
  line: SaidLine,
  result: Audio,
): void {
  const lineId = randomUUID();
  const cancelDeadline = deps.timers.setTimer(playbackDeadlineMs, () =>
    deadlinePassed(state, deps, lineId),
  );
  state.playing = {
    lineId,
    taskId: line.taskId,
    kind: line.kind,
    cancelDeadline,
  };
  const { audio, mimeType } = result;
  const sent = guarded("sendSpeech", () =>
    deps.sendSpeech({ lineId, audio, mimeType }),
  );
  if (!sent && endPlaying(state, lineId)) pump(state, deps);
}

function synthesisFailed(
  state: SpeechState,
  deps: SpeechDeps,
  failure: Failed,
): void {
  if (failure.cause === "error") {
    log(`line dropped: synthesis error ${failure.detail}`);
    return;
  }
  const cause = failure.cause;
  log(`line dropped: voice down (${cause}) ${failure.detail}`);
  if (!state.voiceAvailable) return;
  state.voiceAvailable = false;
  guarded("onVoiceAvailable", () => deps.onVoiceAvailable(false, cause));
}

function synthesisSettled(
  state: SpeechState,
  deps: SpeechDeps,
  job: Job,
  result: Synthesis,
  startedAt: number,
): void {
  if (state.synthesizing !== job) return;
  state.synthesizing = null;
  log(`synthesis in ${Math.round(performance.now() - startedAt)} ms`);
  if (result.kind === "failed") {
    synthesisFailed(state, deps, result);
    pump(state, deps);
    return;
  }
  const wasDown = !state.voiceAvailable;
  state.voiceAvailable = true;
  startPlaying(state, deps, job.line, result);
  if (!wasDown) return;
  log("voice back");
  guarded("onVoiceAvailable", () => deps.onVoiceAvailable(true, null));
}

function synthesize(state: SpeechState, deps: SpeechDeps, job: Job): void {
  const startedAt = performance.now();
  const settle = (result: Synthesis) =>
    synthesisSettled(state, deps, job, result, startedAt);
  // Wrapped so a synchronous throw takes the same path as a rejection.
  new Promise<Synthesis>((resolve) =>
    resolve(deps.synthesize(job.line.text, job.abort.signal)),
  )
    .then(settle, (error: unknown) =>
      settle({ kind: "failed", cause: "error", detail: describeError(error) }),
    )
    .catch((error: unknown) => {
      log(`settling a synthesis threw: ${describeError(error)}`);
    });
}

function pump(state: SpeechState, deps: SpeechDeps): void {
  if (state.held || state.muted) return;
  if (state.synthesizing !== null || state.playing !== null) return;
  const line = state.pending.shift();
  if (line === undefined) return;
  const job: Job = { line, abort: new AbortController() };
  state.synthesizing = job;
  synthesize(state, deps, job);
}

function speakLine(state: SpeechState, deps: SpeechDeps, line: SaidLine) {
  if (state.muted) {
    log(`line dropped: muted (${line.kind})`);
    return;
  }
  const taskId = line.taskId;
  if (taskId !== null && state.cancelled.has(taskId)) {
    log(`line dropped: task cancelled (${line.kind})`);
    return;
  }
  if (taskId !== null && line.kind !== "letMeCheck") {
    const superseded: Matches = (other) =>
      other.taskId === taskId && other.kind === "letMeCheck";
    const why = `"Let me check." superseded by the ${line.kind} line`;
    dropPending(state, superseded, why);
    dropSynthesis(state, superseded, why);
  }
  state.pending.push(line);
  pump(state, deps);
}

function startHold(state: SpeechState, deps: SpeechDeps): void {
  state.held = true;
  clearSpeech(state, deps, {
    matches: everyLine,
    why: "key pressed",
    sendStop: true,
  });
}

function endHold(state: SpeechState, deps: SpeechDeps): void {
  if (!state.held) return;
  state.held = false;
  pump(state, deps);
}

function changeMuted(state: SpeechState, deps: SpeechDeps, muted: boolean) {
  if (state.muted === muted) return;
  state.muted = muted;
  if (muted) {
    clearSpeech(state, deps, {
      matches: everyLine,
      why: "muted",
      sendStop: true,
    });
  }
  pump(state, deps);
}

function cancelLines(state: SpeechState, deps: SpeechDeps, taskId: TaskId) {
  state.cancelled.add(taskId);
  const matches: Matches = (line) => line.taskId === taskId;
  clearSpeech(state, deps, { matches, why: "task cancelled", sendStop: true });
  pump(state, deps);
}

function finishPlayback(
  state: SpeechState,
  deps: SpeechDeps,
  payload: PlaybackFinished,
): void {
  if (!endPlaying(state, payload.lineId)) return;
  if (payload.outcome === "failed") log("playback failed in the renderer");
  pump(state, deps);
}

// The renderer and its key state are gone, so nothing is told to stop.
function forgetRenderer(state: SpeechState, deps: SpeechDeps): void {
  state.held = false;
  const clear = { matches: everyLine, why: "renderer reset", sendStop: false };
  clearSpeech(state, deps, clear);
  pump(state, deps);
}

export function createSpeech(deps: SpeechDeps): Speech {
  const state: SpeechState = {
    pending: [],
    synthesizing: null,
    playing: null,
    held: false,
    muted: false,
    cancelled: new Set(),
    voiceAvailable: true,
  };
  return {
    speak: (line) => speakLine(state, deps, line),
    holdStarted: () => startHold(state, deps),
    holdEnded: () => endHold(state, deps),
    setMuted: (muted) => changeMuted(state, deps, muted),
    cancelTask: (taskId) => cancelLines(state, deps, taskId),
    playbackFinished: (payload) => finishPlayback(state, deps, payload),
    rendererReset: () => forgetRenderer(state, deps),
  };
}
