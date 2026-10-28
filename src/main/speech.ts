import type { TaskId } from "../shared/cards";
import type { PlaybackFinished } from "../shared/ipc";
import type {
  Matches,
  SpeechContext,
  SpeechDeps,
  SpeechState,
} from "./speech-model";
import { endPlaying, log, stopPlaying } from "./speech-model";
import { startRest } from "./speech-rest";
import { auraClosed, auraHeard, startStream } from "./speech-stream";
import type { SaidLine } from "./tasks/state";

export type { VoiceDownCause } from "./speech-model";

type Speech = {
  speak(line: SaidLine): void;
  holdStarted(): void;
  holdEnded(): void;
  setMuted(muted: boolean): void;
  cancelTask(taskId: TaskId): void;
  playbackFinished(payload: PlaybackFinished): void;
  rendererReset(): void;
};

const everyLine: Matches = () => true;
const cancelledLimit = 64;

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

function clearSpeech(
  ctx: SpeechContext,
  clear: { matches: Matches; why: string; sendStop: boolean },
): void {
  dropPending(ctx.state, clear.matches, clear.why);
  dropSynthesis(ctx.state, clear.matches, clear.why);
  stopPlaying(ctx, clear.matches, clear.sendStop);
}

// The open Aura socket streams the line; without it the line goes to the REST call.
function pump(ctx: SpeechContext): void {
  const { state, aura } = ctx;
  if (state.held || state.muted) return;
  if (state.synthesizing !== null || state.playing !== null) return;
  const line = state.pending.shift();
  if (line === undefined) return;
  if (aura !== null && aura.isOpen()) startStream(ctx, aura, line);
  else startRest(ctx, line);
}

function speakLine(ctx: SpeechContext, line: SaidLine): void {
  const { state } = ctx;
  if (state.muted) return log(`line dropped: muted (${line.kind})`);
  const taskId = line.taskId;
  if (taskId !== null && state.cancelled.has(taskId)) {
    return log(`line dropped: task cancelled (${line.kind})`);
  }
  if (taskId !== null && line.kind !== "letMeCheck") {
    const superseded: Matches = (other) =>
      other.taskId === taskId && other.kind === "letMeCheck";
    const why = `"Let me check." superseded by the ${line.kind} line`;
    dropPending(state, superseded, why);
    dropSynthesis(state, superseded, why);
  }
  state.pending.push(line);
  pump(ctx);
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
    pump: () => pump(ctx),
  };
  ctx.aura = deps.startAura({
    heard: (event) => auraHeard(ctx, event),
    closed: () => auraClosed(ctx),
  });
  return {
    speak: (line) => speakLine(ctx, line),
    holdStarted: () => startHold(ctx),
    holdEnded: () => endHold(ctx),
    setMuted: (muted) => changeMuted(ctx, muted),
    cancelTask: (taskId) => cancelLines(ctx, taskId),
    playbackFinished: (payload) => finishPlayback(ctx, payload),
    rendererReset: () => forgetRenderer(ctx),
  };
}
