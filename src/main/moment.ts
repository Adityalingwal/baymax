export type Moment = {
  start: (key: string, now: number) => void; // at an accepted release (the utterance id) or a typed submit
  ended: (key: string) => void; // that generation was discarded or not caught
  audioStarted: (key: string) => number | null; // that generation's first talker audio: when it started, or null when unknown
  cancel: () => void; // a renderer reset or voice stop: every generation
};

type Generation = { startedAt: number; cancelTimer: (() => void) | null };

// If the talker has said nothing about 1.5 s after release, code says "One moment."
const momentMs = 1500;
// Generations whose talker never spoke must not pile up.
const generationLimit = 16;

// Each release or submit has its own timer; only that generation's own events cancel it.
export function createMoment(deps: {
  setTimer: (ms: number, fire: () => void) => () => void;
  sayMoment: (key: string) => void;
  dropMoment: (key: string) => void; // its "One moment." not yet playing is dropped
}): Moment {
  const generations = new Map<string, Generation>();
  const finish = (key: string): Generation | null => {
    const generation = generations.get(key) ?? null;
    generations.delete(key);
    generation?.cancelTimer?.();
    deps.dropMoment(key);
    return generation;
  };
  return {
    start: (key, now) => {
      finish(key);
      const generation: Generation = { startedAt: now, cancelTimer: null };
      generations.set(key, generation);
      generation.cancelTimer = deps.setTimer(momentMs, () => {
        generation.cancelTimer = null;
        deps.sayMoment(key);
      });
      if (generations.size <= generationLimit) return;
      const oldest = generations.keys().next();
      if (oldest.done !== true) finish(oldest.value);
    },
    ended: (key) => {
      finish(key);
    },
    audioStarted: (key) => finish(key)?.startedAt ?? null,
    cancel: () => {
      for (const key of [...generations.keys()]) finish(key);
    },
  };
}
