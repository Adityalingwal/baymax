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
import type { SaidLine, Timers } from "./tasks/state";

export type VoiceDownCause = "unreachable" | "keyRejected" | "noCredit";

export type SpeechDeps = {
  synthesize: (text: string, signal: AbortSignal) => Promise<Synthesis>;
  startAura: (listener: AuraListener) => Aura | null; // null when there is no Deepgram key
  sendSpeech: (line: SpeechLine) => void;
  sendChunk: (chunk: SpeechChunk) => void;
  sendEnd: (end: SpeechEnd) => void;
  sendStop: (payload: StopPlayback) => void;
  onVoiceAvailable: (available: boolean, cause: VoiceDownCause | null) => void; // only on a change
  timers: Timers;
};

// A distinct object per synthesis, so a settled job can tell whether it still owns the slot.
export type Job = { line: SaidLine; abort: AbortController };

// A line on the Aura socket while its text and audio still flow; seq numbers its chunks.
export type StreamJob = {
  seq: number;
  flushesSent: number;
  flushesDone: number;
  spokeSinceFlush: boolean;
  textEnded: boolean;
};

// The line that owns playback, from its first audio until the renderer reports its end.
export type Playing = {
  lineId: LineId;
  line: SaidLine;
  cancelDeadline: () => void;
  stream: StreamJob | null;
};

export type SpeechState = {
  pending: SaidLine[];
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

export type Spoken = Pick<SaidLine, "taskId" | "kind">;
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

// A stream cut before its audio ended is cleared on the socket, so its audio stops coming.
export function endPlaying(ctx: SpeechContext, lineId: LineId): boolean {
  const playing = ctx.state.playing;
  if (playing === null || playing.lineId !== lineId) return false;
  ctx.state.playing = null;
  guarded("cancelDeadline", playing.cancelDeadline);
  if (playing.stream !== null) guarded("clear", () => ctx.aura?.clear());
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
  line: SaidLine,
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
