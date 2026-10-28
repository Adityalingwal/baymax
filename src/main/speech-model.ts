import { randomUUID } from "node:crypto";
import type { Aura, AuraListener } from "../providers/aura";
import type { Synthesis } from "../providers/deepgram";
import type { TaskId } from "../shared/cards";
import type {
  LineId,
  SpeechChunk,
  SpeechEnd,
  SpeechLine,
  StopPlayback,
} from "../shared/ipc";
import type { SaidKind, Timers } from "./tasks/state";

export type VoiceDownCause = "unreachable" | "keyRejected" | "noCredit";

export type SpeechDeps = {
  synthesize: (text: string, signal: AbortSignal) => Promise<Synthesis>;
  startAura: (listener: AuraListener) => Aura | null; // null when there is no Deepgram key
  sendSpeech: (line: SpeechLine) => void;
  sendChunk: (chunk: SpeechChunk) => void;
  sendEnd: (end: SpeechEnd) => void;
  sendStop: (payload: StopPlayback) => void;
  onVoiceAvailable: (available: boolean, cause: VoiceDownCause | null) => void; // only on a change
  onAudioStarted: (line: Spoken) => void; // a line's first audio reached the renderer
  timers: Timers;
};

// A line's text: whole at once, or fed piece by piece by the talker until it ends.
export type LineText = {
  text: string;
  ended: boolean;
  changed: (() => void) | null;
};

// key: the generation (release or typed question) of a talker reply, else null.
export type Line = {
  taskId: TaskId | null;
  kind: SaidKind;
  key: string | null;
  feed: LineText;
};

// A distinct object per synthesis, so a settled job can tell whether it still owns the slot.
export type Job = { line: Line; abort: AbortController };

// A line on the Aura socket while its text and audio still flow; seq numbers its chunks.
export type StreamJob = {
  seq: number;
  taken: number; // characters of the line's text already cut into clauses
  flushesSent: number;
  flushesDone: number;
  spokeSinceFlush: boolean;
  textEnded: boolean;
};

// The line that owns playback, from its first audio until the renderer reports its end.
export type Playing = {
  lineId: LineId;
  line: Line;
  cancelDeadline: () => void;
  stream: StreamJob | null;
};

export type SpeechState = {
  pending: Line[];
  synthesizing: Job | null;
  playing: Playing | null;
  held: boolean;
  muted: boolean;
  cancelled: Set<TaskId>;
  voiceAvailable: boolean;
};

export type SpeechContext = {
  state: SpeechState;
  deps: SpeechDeps;
  aura: Aura | null;
  pump: () => void;
};

export type Spoken = Pick<Line, "taskId" | "kind" | "key">;
export type Matches = (line: Spoken) => boolean;

// A renderer that never reports must not block speech forever.
const playbackDeadlineMs = 60_000;

export function log(message: string): void {
  console.log(`[Speech] ${message}`);
}

export function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

// An injected callback that throws is logged; it never breaks the speech state.
export function guarded(name: string, call: () => void): boolean {
  try {
    call();
    return true;
  } catch (error) {
    log(`${name} threw: ${describeError(error)}`);
    return false;
  }
}

// A stream cut before its audio ended restarts the socket, so none of its audio reaches the next line.
export function endPlaying(ctx: SpeechContext, lineId: LineId): boolean {
  const playing = ctx.state.playing;
  if (playing === null || playing.lineId !== lineId) return false;
  ctx.state.playing = null;
  guarded("cancelDeadline", playing.cancelDeadline);
  if (playing.stream !== null) guarded("restart", () => ctx.aura?.restart());
  return true;
}

export function stopPlaying(
  ctx: SpeechContext,
  matches: Matches,
  sendStop: boolean,
): void {
  const playing = ctx.state.playing;
  if (playing === null || !matches(playing.line)) return;
  endPlaying(ctx, playing.lineId);
  if (!sendStop) return;
  const lineId = playing.lineId;
  guarded("sendStop", () => ctx.deps.sendStop({ lineId }));
}

function deadlinePassed(ctx: SpeechContext, lineId: LineId): void {
  if (!endPlaying(ctx, lineId)) return;
  log("playback timeout: the renderer never reported the line's end");
  guarded("sendStop", () => ctx.deps.sendStop({ lineId }));
  ctx.pump();
}

// Gives the line the playback slot with its deadline; without a deadline a lost report could block speech for good.
export function occupy(
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
  if (!timed) return null;
  ctx.state.playing = { lineId, line, cancelDeadline, stream };
  return ctx.state.playing;
}

export function voiceBack(ctx: SpeechContext): void {
  if (ctx.state.voiceAvailable) return;
  ctx.state.voiceAvailable = true;
  log("voice back");
  guarded("onVoiceAvailable", () => ctx.deps.onVoiceAvailable(true, null));
}
