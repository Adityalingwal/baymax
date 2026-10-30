import { useEffect, useReducer, useState } from "react";
import type { Dispatch } from "react";
import { createHitTest } from "./outline";
import type { HitTest, HitZone } from "./outline";
import { initialPanel, panelDelays, panelReducer } from "./shell";
import type { PanelEvent, PanelState } from "./shell";

export type PointerZones = {
  notch: HitZone | null; // the hover sensor that opens the panel; off while the answer island shows
  opened: HitZone; // the open panel's full outline
  visible: () => string; // the shape as drawn now
};

type Tracker = {
  zones: PointerZones;
  captured: boolean;
  mouseDown: boolean;
  point: { x: number; y: number } | null;
  hitTest: HitTest;
  dispatch: Dispatch<PanelEvent>;
};

function setCapture(tracker: Tracker, captured: boolean): void {
  if (tracker.captured === captured) return;
  tracker.captured = captured;
  window.baymax.setMouseCapture({ captured });
}

// Clicks land only on what is drawn; a press that started inside keeps them until it is released, so its mouse-up comes back.
function evaluate(tracker: Tracker, moved = false): void {
  const { point, zones, hitTest } = tracker;
  if (point === null) {
    setCapture(tracker, tracker.mouseDown);
    return;
  }
  const { x, y } = point;
  const inVisible = hitTest({ kind: "path", path: zones.visible() }, x, y);
  setCapture(tracker, inVisible || tracker.mouseDown);
  tracker.dispatch({
    kind: "pointer",
    inNotch: zones.notch !== null && hitTest(zones.notch, x, y),
    inOpenOutline: hitTest(zones.opened, x, y),
    inVisible,
    moved,
  });
}

function forgetPointer(tracker: Tracker): void {
  tracker.point = null;
  tracker.dispatch({ kind: "pointer-gone" });
  evaluate(tracker);
}

function setMouseDown(tracker: Tracker, down: boolean): void {
  if (tracker.mouseDown === down) return;
  tracker.mouseDown = down;
  tracker.dispatch({ kind: "mouse", down });
  evaluate(tracker);
}

function listen(tracker: Tracker): () => void {
  const move = (event: MouseEvent) => {
    tracker.point = { x: event.clientX, y: event.clientY };
    // A release that happened where this window could not see it.
    if (tracker.mouseDown && event.buttons === 0) setMouseDown(tracker, false);
    evaluate(tracker, true);
  };
  const leave = (event: MouseEvent) => {
    const { clientX: x, clientY: y } = event;
    const inside =
      x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
    if (inside) return;
    forgetPointer(tracker);
  };
  // A leave can report a point inside, or never come, so main watches the cursor while the page holds the mouse.
  const stopOutside = window.baymax.onPointerOutside(() =>
    forgetPointer(tracker),
  );
  // A Space change closes like Esc: the text stays, and a pointer still on the notch waits to leave first.
  const stopSpace = window.baymax.onSpaceChanged(() =>
    tracker.dispatch({ kind: "escape" }),
  );
  // Only a captured window gets the press, so it always started inside the shape.
  const down = () => setMouseDown(tracker, true);
  const up = () => setMouseDown(tracker, false);
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseleave", leave);
  document.addEventListener("mousedown", down);
  window.addEventListener("mouseup", up);
  window.addEventListener("blur", up);
  return () => {
    stopOutside();
    stopSpace();
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseleave", leave);
    document.removeEventListener("mousedown", down);
    window.removeEventListener("mouseup", up);
    window.removeEventListener("blur", up);
    setCapture(tracker, false);
  };
}

// Keyed by the token, so a render never restarts a running timer.
function useTimer(
  token: number | null,
  ms: number,
  kind: "dwell-elapsed" | "leave-elapsed" | "draft-leave-elapsed",
  dispatch: Dispatch<PanelEvent>,
): void {
  useEffect(() => {
    if (token === null) return;
    const timer = setTimeout(() => dispatch({ kind, token }), ms);
    return () => clearTimeout(timer);
  }, [token, ms, kind, dispatch]);
}

export type PanelPointer = {
  state: PanelState;
  dispatch: Dispatch<PanelEvent>;
  frameChanged: () => void; // the drawn shape moved under a still pointer
};

export function usePointer(
  zones: PointerZones,
  holds: { needsAccess: boolean; draft: string; shapeKey: unknown },
): PanelPointer {
  const [state, dispatch] = useReducer(panelReducer, initialPanel);
  const [tracker] = useState<Tracker>(() => ({
    zones,
    captured: false,
    mouseDown: false,
    point: null,
    hitTest: createHitTest(),
    dispatch,
  }));
  tracker.zones = zones;
  useEffect(() => listen(tracker), [tracker]);
  useEffect(() => evaluate(tracker), [tracker, zones]);
  const { needsAccess, draft, shapeKey } = holds;
  useEffect(
    () => dispatch({ kind: "access", needed: needsAccess }),
    [needsAccess],
  );
  useEffect(() => dispatch({ kind: "draft", text: draft }), [draft]);
  // A new window shape means the window moved: whatever the pointer was over is gone.
  useEffect(() => forgetPointer(tracker), [tracker, shapeKey]);
  useTimer(state.dwell, panelDelays.dwellMs, "dwell-elapsed", dispatch);
  useTimer(state.leave, panelDelays.leaveMs, "leave-elapsed", dispatch);
  useTimer(
    state.draftLeave,
    panelDelays.draftMs,
    "draft-leave-elapsed",
    dispatch,
  );
  return { state, dispatch, frameChanged: () => evaluate(tracker) };
}
