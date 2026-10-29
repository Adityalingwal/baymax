import type { LineId, SpeechChunk } from "../shared/ipc";

// A smaller shortfall is within the renderer's own scheduling slack and is not heard.
const dryLimitMs = 100;

type Watched = { lineId: LineId; startedAt: number; audioMs: number };

// Logs when a streamed line's audio ran out before its next chunk arrived, which the listener hears as a gap.
export function createGapWatch(
  now: () => number,
  log: (message: string) => void,
): (chunk: SpeechChunk) => void {
  let watched: Watched | null = null;
  return (chunk) => {
    const at = now();
    if (watched === null || watched.lineId !== chunk.lineId) {
      watched = { lineId: chunk.lineId, startedAt: at, audioMs: 0 };
    }
    const dryMs = at - (watched.startedAt + watched.audioMs);
    if (dryMs >= dryLimitMs) {
      log(
        `speech gap: audio ran dry ${Math.round(dryMs)} ms before chunk ${chunk.seq}`,
      );
    }
    if (dryMs > 0) watched.startedAt += dryMs; // playback resumes with this chunk
    // linear16 mono: two bytes per sample
    watched.audioMs += (chunk.pcm.byteLength / 2 / chunk.sampleRate) * 1000;
  };
}
