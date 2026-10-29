import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  motionEnd,
  panelTiming,
  planPanel,
  restingFrame,
  sample,
} from "./motion";
import type { Frame, Motion, PanelKeys } from "./motion";
import { silhouettePath } from "./outline";

type Runner = {
  frame: Frame;
  path: string;
  motion: Motion | null;
  raf: number | null;
};

export type ShellMotion = {
  shapeRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  visiblePath: () => string; // the shape as drawn now, for hit-testing
};

type MotionInput = {
  open: boolean;
  keys: PanelKeys;
  windowWidth: number;
  onFrame: () => void;
  onSettled: (open: boolean) => void;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Written straight to the elements: a React render per frame would be too slow for a 60 fps shape.
function draw(
  runner: Runner,
  windowWidth: number,
  shape: HTMLDivElement | null,
  content: HTMLElement | null,
): void {
  const { frame } = runner;
  runner.path = silhouettePath(windowWidth, frame);
  if (shape !== null) {
    shape.style.clipPath = `path("${runner.path}")`;
    shape.style.opacity = String(frame.shade);
  }
  if (content !== null) {
    const offset = (frame.content - 1) * panelTiming.slide;
    content.style.opacity = String(frame.content);
    content.style.transform = `translateY(${offset}px)`;
  }
}

// One frame loop that runs only while a motion does; the window is always on screen, so an idle loop would waste power.
export function useShellMotion(input: MotionInput): ShellMotion {
  const { open, keys, windowWidth } = input;
  const shapeRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const callbacks = useRef(input);
  callbacks.current = input;
  const [runner] = useState<Runner>(() => ({
    frame: restingFrame(keys.collapsed, false),
    path: "",
    motion: null,
    raf: null,
  }));

  useLayoutEffect(() => {
    draw(runner, windowWidth, shapeRef.current, contentRef.current);
  }, [runner, windowWidth]);

  useEffect(() => {
    const step = (now: number) => {
      const motion = runner.motion;
      if (motion === null) return;
      runner.frame = sample(motion, now);
      draw(runner, windowWidth, shapeRef.current, contentRef.current);
      callbacks.current.onFrame();
      if (now < motionEnd(motion)) {
        runner.raf = requestAnimationFrame(step);
        return;
      }
      runner.motion = null;
      runner.raf = null;
      callbacks.current.onSettled(open);
    };
    const how = {
      open,
      reduced: prefersReducedMotion(),
      now: performance.now(),
    };
    runner.motion = planPanel(runner.frame, keys, how);
    if (runner.raf !== null) cancelAnimationFrame(runner.raf);
    runner.raf = requestAnimationFrame(step);
    return () => {
      if (runner.raf !== null) cancelAnimationFrame(runner.raf);
      runner.raf = null;
    };
  }, [runner, open, keys, windowWidth]);

  return { shapeRef, contentRef, visiblePath: () => runner.path };
}
