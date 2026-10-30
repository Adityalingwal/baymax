import { speechStartBufferMs } from "../shared/ipc";
import type { LineId, SpeechChunk } from "../shared/ipc";
import type { LineFeed, Spoken } from "./speech";

type TalkerTiming = {
  released: (key: string, now: number) => void; // an accepted release or a typed submit
  audioStarted: (line: Spoken) => void; // a line's first audio reached the renderer
  timed: (key: string | null, feed: LineFeed) => LineFeed; // a talker reply's line (with a key), timed
};

type Release = { at: number; logged: Set<string> };

// Releases whose events never came must not pile up.
const releaseLimit = 16;

// Logs when a generation's talker reply steps happen, in ms after its release, once each.
export function createTalkerTiming(deps: {
  now: () => number;
  log: (message: string) => void;
}): TalkerTiming {
  const releases = new Map<string, Release>();
  const once = (key: string, what: string) => {
    const release = releases.get(key);
    if (release === undefined || release.logged.has(what)) return;
    release.logged.add(what);
    const ms = Math.round(deps.now() - release.at);
    deps.log(`${what} ${ms} ms after release`);
  };
  return {
    released: (key, now) => {
      releases.delete(key);
      releases.set(key, { at: now, logged: new Set() });
      if (releases.size <= releaseLimit) return;
      const oldest = releases.keys().next();
      if (oldest.done !== true) releases.delete(oldest.value);
    },
    audioStarted: ({ kind, key }) => {
      if (key !== null && kind === "talk") once(key, "talker first audio");
    },
    timed: (key, feed) => {
      if (key === null) return feed;
      once(key, "talker reply asked");
      return {
        push: (text) => {
          if (text !== "") once(key, "talker first text");
          feed.push(text);
        },
        end: () => {
          once(key, "talker text ended");
          feed.end();
        },
        cut: feed.cut,
      };
    },
  };
}

// A smaller shortfall is within the renderer's own scheduling slack and is not heard.
const dryLimitMs = 100;

type Watched = { lineId: LineId; startedAt: number; audioMs: number };

// Logs when a streamed line's audio ran out before its next chunk arrived, which the listener hears as a gap.
// The renderer's dropped lead silence is not counted, so a line that lost some can run dry without a log.
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
    const playsUntil =
      watched.startedAt + speechStartBufferMs + watched.audioMs;
    const dryMs = at - playsUntil;
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
