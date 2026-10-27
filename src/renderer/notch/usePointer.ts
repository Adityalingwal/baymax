import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Dispatch } from "react";
import { createHitTest, hoverZone, shellOutline } from "./outline";
import type { HitTest, HitZone, OutlineGeometry } from "./outline";
import {
  foldedOrClosed,
  initialPointer,
  pointerReducer,
  shellMode,
} from "./shell";
import type {
  PointerChange,
  PointerState,
  ShellMode,
  ShellReasons,
} from "./shell";

const exitDelayMs = 100;

type PointerView = PointerState & {
  capture: HitZone;
  hover: HitZone;
  // Open only: the hover zone of the mode the shell would collapse to.
  collapsedHover: HitZone | null;
};

type Tracker = {
  view: PointerView;
  captured: boolean;
  point: { x: number; y: number } | null;
  exitTimer: ReturnType<typeof setTimeout> | null;
  hitTest: HitTest;
  dispatch: Dispatch<PointerChange>;
};

function setCapture(tracker: Tracker, captured: boolean): void {
  if (tracker.captured === captured) return;
  tracker.captured = captured;
  window.baymax.setMouseCapture({ captured });
}

function cancelExit(tracker: Tracker): void {
  if (tracker.exitTimer === null) return;
  clearTimeout(tracker.exitTimer);
  tracker.exitTimer = null;
}

function inHover(tracker: Tracker, x: number, y: number): boolean {
  const { view, hitTest } = tracker;
  if (hitTest(view.hover, x, y)) return true;
  // The hover margin beside the neck lies outside the open outline; without this the shell flips every 100 ms.
  return view.collapsedHover !== null && hitTest(view.collapsedHover, x, y);
}

// Tests the last pointer position against the current zones; always the target outline, never the animating one.
function evaluate(tracker: Tracker): void {
  const { point, view } = tracker;
  if (point === null) return;
  const inShape = tracker.hitTest(view.capture, point.x, point.y);
  setCapture(tracker, inShape);
  // The wait ends only once the pointer is out of the collapsed hover zone, or a still pointer would reopen it.
  if (view.waitForExit) {
    if (!inHover(tracker, point.x, point.y)) {
      tracker.dispatch({ kind: "outside-collapsed" });
    }
    return;
  }
  if (inHover(tracker, point.x, point.y)) {
    cancelExit(tracker);
    tracker.dispatch({ kind: "inside" });
    return;
  }
  if (!view.hovered || tracker.exitTimer !== null) return;
  tracker.exitTimer = setTimeout(() => {
    tracker.exitTimer = null;
    tracker.dispatch({ kind: "outside-after-delay" });
  }, exitDelayMs);
}

function release(tracker: Tracker, change: "left-window" | "blur"): void {
  cancelExit(tracker);
  tracker.point = null;
  setCapture(tracker, false);
  tracker.dispatch({ kind: change });
}

function listen(tracker: Tracker): () => void {
  const move = (event: MouseEvent) => {
    tracker.point = { x: event.clientX, y: event.clientY };
    evaluate(tracker);
  };
  const leave = (event: MouseEvent) => {
    const { clientX: x, clientY: y } = event;
    const inside =
      x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
    if (!inside) release(tracker, "left-window");
  };
  const blur = () => release(tracker, "blur");
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseleave", leave);
  window.addEventListener("blur", blur);
  return () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseleave", leave);
    window.removeEventListener("blur", blur);
    cancelExit(tracker);
    setCapture(tracker, false);
  };
}

function useTracker(view: PointerView, dispatch: Dispatch<PointerChange>) {
  const [tracker] = useState<Tracker>(() => ({
    view,
    captured: false,
    point: null,
    exitTimer: null,
    hitTest: createHitTest(),
    dispatch,
  }));
  useEffect(() => listen(tracker), [tracker]);
  // After every mode or outline change, so a shape that shrinks away from a still pointer releases it.
  useEffect(() => {
    tracker.view = view;
    evaluate(tracker);
  }, [tracker, view]);
  return tracker;
}

// A fold or close that leaves only the pointer holding the shell open collapses it until the pointer leaves.
function useFoldWatch(
  reasons: ShellReasons,
  dispatch: Dispatch<PointerChange>,
): void {
  const previous = useRef(reasons.tasks);
  useEffect(() => {
    const before = previous.current;
    previous.current = reasons.tasks;
    if (!foldedOrClosed(before, reasons.tasks)) return;
    const unhovered = { ...reasons, ...initialPointer };
    if (shellMode(unhovered) !== "open") dispatch({ kind: "folded-or-closed" });
  }, [reasons, dispatch]);
}

function usePointerView(
  geometry: OutlineGeometry,
  mode: ShellMode,
  collapsed: ShellMode,
  pointer: PointerState,
): PointerView {
  const { width, height, shape, contentHeight } = geometry;
  return useMemo(() => {
    const current = { width, height, shape, contentHeight };
    const capture: HitZone = {
      kind: "path",
      path: shellOutline(current, mode),
    };
    const collapsedHover =
      mode === "open" && collapsed !== "open"
        ? hoverZone(current, collapsed)
        : null;
    return {
      ...pointer,
      capture,
      hover: hoverZone(current, mode),
      collapsedHover,
    };
  }, [width, height, shape, contentHeight, mode, collapsed, pointer]);
}

export function usePointer(
  geometry: OutlineGeometry,
  reasons: ShellReasons,
): ShellMode {
  const [pointer, dispatch] = useReducer(pointerReducer, initialPointer);
  const mode = shellMode({ ...reasons, ...pointer });
  const collapsed = shellMode({ ...reasons, ...initialPointer });
  const view = usePointerView(geometry, mode, collapsed, pointer);
  const tracker = useTracker(view, dispatch);
  useFoldWatch(reasons, dispatch);
  // A new shape means the window moved: whatever the pointer was over is gone.
  useEffect(() => release(tracker, "left-window"), [tracker, geometry.shape]);
  return mode;
}
