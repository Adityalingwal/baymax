import type { HoldState } from "../shared/ipc";

type HoldTracker = {
  keyDown(keycode: number): HoldState | null;
  keyUp(keycode: number): HoldState | null;
  reset(): void;
};

export function createHoldTracker(keys: readonly number[]): HoldTracker {
  const pressed = new Set<number>();
  let listening = false;

  // An empty combo would match vacuously and fire on any key, so it never matches.
  const comboPressed = (): boolean =>
    keys.length > 0 && keys.every((key) => pressed.has(key));

  return {
    keyDown(keycode) {
      // Key repeat sends keydown again for a key already held; ignore it.
      if (pressed.has(keycode)) return null;
      pressed.add(keycode);
      if (listening || !comboPressed()) return null;
      listening = true;
      return "listening";
    },
    keyUp(keycode) {
      pressed.delete(keycode);
      if (!listening || comboPressed()) return null;
      listening = false;
      return "idle";
    },
    reset() {
      pressed.clear();
      listening = false;
    },
  };
}
