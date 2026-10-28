import type { LineFeed } from "./speech";
import type { Spoken } from "./speech-model";

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
