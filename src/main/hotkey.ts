import { uIOhook } from "uiohook-napi";
import type { UiohookKeyboardEvent } from "uiohook-napi";
import type { HoldState } from "../shared/ipc";
import { createHoldTracker, holdLimits } from "./hold";
import type { HoldOutcome } from "./hold";
import { holdKeyLabel, holdKeys } from "./platform";

type HoldChangeCallback = (
  state: HoldState,
  outcome: HoldOutcome | null,
) => void;

const tracker = createHoldTracker(holdKeys);
let hookRunning = false;
let holdChangeCallback: HoldChangeCallback | null = null;
let capTimer: ReturnType<typeof setTimeout> | null = null;

function clearCapTimer(): void {
  if (capTimer === null) return;
  clearTimeout(capTimer);
  capTimer = null;
}

function reportListening(): void {
  clearCapTimer();
  capTimer = setTimeout(
    () => reportHoldEnd(tracker.endAtCap(), true),
    holdLimits.longestMs,
  );
  console.log("[Hotkey] Listening started");
  holdChangeCallback?.("listening", null);
}

function reportHoldEnd(outcome: HoldOutcome | null, atCap: boolean): void {
  if (outcome === null) return;
  clearCapTimer();
  console.log("[Hotkey] Listening stopped");
  if (atCap) console.log("[Hotkey] Hold ended at the cap");
  if (outcome === "discard") console.log("[Hotkey] Hold discarded");
  holdChangeCallback?.("idle", outcome);
}

function onKeyDown(event: UiohookKeyboardEvent): void {
  const now = performance.now();
  if (tracker.keyDown(event.keycode, now) === "listening") reportListening();
}

function onKeyUp(event: UiohookKeyboardEvent): void {
  const now = performance.now();
  reportHoldEnd(tracker.keyUp(event.keycode, now), false);
}

export function startHoldKey(onHoldChange: HoldChangeCallback): void {
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
  clearCapTimer();
  tracker.reset();
  hookRunning = false;
}
