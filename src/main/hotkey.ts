import { uIOhook } from "uiohook-napi";
import type { UiohookKeyboardEvent } from "uiohook-napi";
import type { HoldState } from "../shared/ipc";
import { createHoldTracker } from "./hold";
import { holdKeyLabel, holdKeys } from "./platform";

const tracker = createHoldTracker(holdKeys);
let hookRunning = false;
let holdChangeCallback: ((state: HoldState) => void) | null = null;

function reportHoldChange(state: HoldState | null): void {
  if (state === null) return;
  console.log(
    state === "listening"
      ? "[Hotkey] Listening started"
      : "[Hotkey] Listening stopped",
  );
  holdChangeCallback?.(state);
}

function onKeyDown(event: UiohookKeyboardEvent): void {
  reportHoldChange(tracker.keyDown(event.keycode));
}

function onKeyUp(event: UiohookKeyboardEvent): void {
  reportHoldChange(tracker.keyUp(event.keycode));
}

export function startHoldKey(onHoldChange: (state: HoldState) => void): void {
  if (hookRunning) return;
  console.log("[Hotkey] Starting hotkey listener...");
  console.log(
    `[Hotkey] Mode: ${holdKeyLabel} - HOLD to listen, RELEASE to stop`,
  );
  holdChangeCallback = onHoldChange;
  // Listeners go on before the hook starts, so the first key event is never missed.
  uIOhook.on("keydown", onKeyDown);
  uIOhook.on("keyup", onKeyUp);
  uIOhook.start();
  hookRunning = true;
  console.log("[Hotkey] Listener started");
}

export function stopHoldKey(): void {
  if (!hookRunning) return;
  console.log("[Hotkey] Stopping hotkey listener...");
  uIOhook.stop();
  // uIOhook.stop() keeps JS listeners, so a later start would register them twice.
  uIOhook.removeListener("keydown", onKeyDown);
  uIOhook.removeListener("keyup", onKeyUp);
  tracker.reset();
  hookRunning = false;
}
