export type Moment = {
  start: (key: string, now: number) => void; // at an accepted release (the utterance id) or a typed submit
  ended: (key: string) => void; // that generation was discarded or not caught
  audioStarted: (key: string) => number | null; // that generation's talker audio began: the time it started, or null for another one
  cancel: () => void; // a new hold, a renderer reset or voice stop
};

// If the talker has said nothing about 1.5 s after release, code says "One moment."
const momentMs = 1500;

// One timer, bound to the latest release or submit; only that generation's own events cancel it.
export function createMoment(deps: {
  setTimer: (ms: number, fire: () => void) => () => void;
  sayMoment: (key: string) => void;
}): Moment {
  let current: { key: string; startedAt: number } | null = null;
  let cancelTimer: (() => void) | null = null;
  const cancel = () => {
    const pending = cancelTimer;
    cancelTimer = null;
    pending?.();
  };
  return {
    start: (key, now) => {
      cancel();
      current = { key, startedAt: now };
      cancelTimer = deps.setTimer(momentMs, () => {
        cancelTimer = null;
        deps.sayMoment(key);
      });
    },
    ended: (key) => {
      if (current?.key === key) cancel();
    },
    audioStarted: (key) => {
      if (current?.key !== key) return null;
      cancel();
      return current.startedAt;
    },
    cancel: () => {
      cancel();
      current = null;
    },
  };
}
