export type HoldOutcome = "accept" | "discard";

export const holdLimits = {
  shortestMs: 300, // a shorter hold is a tap, not a question
  longestMs: 90_000, // main ends a longer hold as a release, so a stuck key never records forever
} as const;

type HoldTracker = {
  keyDown(keycode: number, now: number): "listening" | null;
  keyUp(keycode: number, now: number): HoldOutcome | null;
  endAtCap(): HoldOutcome | null;
  reset(): void;
};

export function createHoldTracker(keys: readonly number[]): HoldTracker {
  const pressed = new Set<number>();
  let start: number | null = null;
  let otherKeyPressed = false;

  // An empty combo would match vacuously and fire on any key, so it never matches.
  const comboPressed = (): boolean =>
    keys.length > 0 && keys.every((key) => pressed.has(key));

  return {
    keyDown(keycode, now) {
      // Key repeat sends keydown again for a key already held; ignore it.
      if (pressed.has(keycode)) return null;
      pressed.add(keycode);
      // Only key-downs during the hold count: a key-up missed under macOS secure input would leave a stale key.
      if (start !== null) {
        if (!keys.includes(keycode)) otherKeyPressed = true;
        return null;
      }
      if (!keys.includes(keycode) || !comboPressed()) return null;
      start = now;
      otherKeyPressed = false;
      return "listening";
    },
    keyUp(keycode, now) {
      pressed.delete(keycode);
      if (start === null || comboPressed()) return null;
      const tooShort = now - start < holdLimits.shortestMs;
      start = null;
      return otherKeyPressed || tooShort ? "discard" : "accept";
    },
    endAtCap() {
      if (start === null) return null;
      start = null;
      return "accept";
    },
    reset() {
      pressed.clear();
      start = null;
      otherKeyPressed = false;
    },
  };
}
