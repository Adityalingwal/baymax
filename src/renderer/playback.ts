import type {
  BaymaxApi,
  LineId,
  PlaybackFinished,
  SpeechChunk,
  SpeechEnd,
  SpeechLine,
} from "../shared/ipc";
import { createWebAudioPlayer } from "./web-audio";
import type { Player } from "./web-audio";

type Bridge = Pick<
  BaymaxApi,
  | "onSpeech"
  | "onSpeechChunk"
  | "onSpeechEnd"
  | "onStopPlayback"
  | "reportPlaybackFinished"
>;

type Playback = {
  bridge: Bridge;
  player: Player;
  active: LineId | null;
  nextSeq: number; // the seq the active streamed line's next chunk must carry
  finished: LineId[]; // recent lines that ended or were stopped, whose late chunks are ignored
  disposed: boolean;
};

const finishedLimit = 16;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

// A throwing player or bridge must not leave a line half-finished.
function logged(what: string, call: () => void): void {
  try {
    call();
  } catch (error) {
    console.log(`[Playback] ${what} failed: ${errorName(error)}`);
  }
}

function isActive(playback: Playback, lineId: LineId): boolean {
  return !playback.disposed && playback.active === lineId;
}

function remember(playback: Playback, lineId: LineId): void {
  playback.finished.push(lineId);
  if (playback.finished.length > finishedLimit) playback.finished.shift();
}

function report(
  playback: Playback,
  lineId: LineId,
  outcome: PlaybackFinished["outcome"],
): void {
  remember(playback, lineId);
  logged("reporting", () =>
    playback.bridge.reportPlaybackFinished({ lineId, outcome }),
  );
}

// The one way a line ends, so each line is reported exactly once.
function finish(
  playback: Playback,
  lineId: LineId,
  outcome: PlaybackFinished["outcome"],
): void {
  if (!isActive(playback, lineId)) return;
  playback.active = null;
  if (outcome === "stopped") logged("stopping", () => playback.player.stop());
  report(playback, lineId, outcome);
}

function playFailed(playback: Playback, lineId: LineId, error: unknown) {
  if (!isActive(playback, lineId)) return;
  console.log(`[Playback] failed: ${errorName(error)}`);
  finish(playback, lineId, "failed");
}

function begin(playback: Playback, lineId: LineId): void {
  if (playback.active !== null) finish(playback, playback.active, "stopped");
  playback.active = lineId;
  playback.nextSeq = 0;
}

function playLine(playback: Playback, line: SpeechLine): void {
  if (playback.disposed) return;
  const { lineId } = line;
  begin(playback, lineId);
  const ended = () => finish(playback, lineId, "ended");
  // Wrapped so a synchronous throw takes the same path as a rejection.
  new Promise<void>((resolve) =>
    resolve(playback.player.play(line.audio, ended)),
  ).catch((error: unknown) => playFailed(playback, lineId, error));
}

// A chunk of a stopped line, or one out of seq order, is ignored.
function playChunk(playback: Playback, chunk: SpeechChunk): void {
  const { lineId, seq } = chunk;
  if (playback.disposed || playback.finished.includes(lineId)) return;
  if (playback.active !== lineId) {
    if (seq !== 0) return;
    begin(playback, lineId);
  }
  if (seq !== playback.nextSeq) return;
  playback.nextSeq += 1;
  logged("queueing", () => playback.player.queue(chunk.pcm, chunk.sampleRate));
}

// The line is finished once its end came and its last scheduled chunk has played.
function endStream(playback: Playback, { lineId }: SpeechEnd): void {
  if (playback.disposed || playback.finished.includes(lineId)) return;
  if (playback.active !== lineId) {
    if (playback.active === null) report(playback, lineId, "ended");
    return;
  }
  logged("waiting for the end", () =>
    playback.player.whenDrained(() => finish(playback, lineId, "ended")),
  );
}

function stopLine(playback: Playback, lineId: LineId): void {
  if (!playback.finished.includes(lineId) && playback.active !== lineId) {
    remember(playback, lineId);
  }
  finish(playback, lineId, "stopped");
}

function closePlayback(playback: Playback): void {
  playback.disposed = true;
  playback.active = null;
  logged("stopping", () => playback.player.stop());
  logged("disposing", () => playback.player.dispose());
}

export function startPlayback(
  bridge: Bridge,
  player: Player = createWebAudioPlayer(() => new AudioContext()),
): () => void {
  const playback: Playback = {
    bridge,
    player,
    active: null,
    nextSeq: 0,
    finished: [],
    disposed: false,
  };
  const unsubscribes = [
    bridge.onSpeech((line) => playLine(playback, line)),
    bridge.onSpeechChunk((chunk) => playChunk(playback, chunk)),
    bridge.onSpeechEnd((end) => endStream(playback, end)),
    bridge.onStopPlayback(({ lineId }) => stopLine(playback, lineId)),
  ];
  return () => {
    if (playback.disposed) return;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    // The page is going away, so nothing is reported.
    closePlayback(playback);
  };
}
