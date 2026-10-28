import { fixedLines } from "./tasks/lines";
import type { SaidLine, Timers } from "./tasks/state";

export type Moment = {
  start: () => void; // at key release of an accepted hold, or on a typed submit
  cancel: () => void; // talker audio started, the words were not caught, or a new hold began
};

// If the talker has said nothing about 1.5 s after release, code says "One moment."
const momentMs = 1500;

export function createMoment(deps: {
  timers: Timers;
  say: (line: SaidLine) => void;
}): Moment {
  let cancelTimer: (() => void) | null = null;
  const cancel = () => {
    const pending = cancelTimer;
    cancelTimer = null;
    pending?.();
  };
  return {
    start: () => {
      cancel();
      cancelTimer = deps.timers.setTimer(momentMs, () => {
        cancelTimer = null;
        deps.say({ taskId: null, text: fixedLines.oneMoment, kind: "moment" });
      });
    },
    cancel,
  };
}
