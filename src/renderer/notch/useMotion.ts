import { createRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { motionEnd, sample } from "./motion";
import type { Frame, Motion } from "./motion";
import { silhouettePath } from "./outline";
import type { Silhouette } from "./outline";
import { panelTiming, planPanel, planPill, restingFrame } from "./plans";
import type { PanelKeys } from "./plans";

type Runner = {
  frame: Frame;
  path: string;
  motion: Motion | null;
  raf: number | null;
  open: boolean; // the open state the last motion was planned for
};

export type Layers = {
  shape: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLElement | null>;
  word: RefObject<HTMLDivElement | null>;
  rim: RefObject<SVGSVGElement | null>;
};

export type ShellMotion = {
  layers: Layers;
  visiblePath: () => string; // the shape as drawn now, for hit-testing
};

type MotionInput = {
  open: boolean;
  keys: PanelKeys;
  notch: Silhouette;
  pill: Silhouette;
  windowWidth: number;
  onFrame: () => void;
  onSettled: (open: boolean) => void;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setOpacity(element: HTMLElement | SVGElement | null, value: number) {
  if (element !== null) element.style.opacity = String(value);
}

// Written straight to the elements: a React render per frame would be too slow for a 60 fps shape.
function draw(runner: Runner, windowWidth: number, layers: Layers): void {
  const { frame } = runner;
  runner.path = silhouettePath(windowWidth, frame);
  const shape = layers.shape.current;
  if (shape !== null) shape.style.clipPath = `path("${runner.path}")`;
  setOpacity(shape, frame.shade);
  const content = layers.content.current;
  setOpacity(content, frame.content);
  if (content !== null) {
    const offset = (frame.content - 1) * panelTiming.slide;
    content.style.transform = `translateY(${offset}px)`;
  }
  setOpacity(layers.word.current, frame.pill);
  setOpacity(layers.rim.current, frame.rim);
}

// The panel opening or closing moves on the panel's curves; a closed shape changing (notch and pill) on the pill's.
function plan(runner: Runner, input: MotionInput): Motion {
  const { open, keys } = input;
  const how = { reduced: prefersReducedMotion(), now: performance.now() };
  const panel = open || runner.open !== open;
  runner.open = open;
  if (panel) return planPanel(runner.frame, keys, { ...how, open });
  const pillKeys = { notch: input.notch, pill: input.pill };
  return planPill(runner.frame, pillKeys, { ...how, shown: keys.pill });
}

// One frame loop that runs only while a motion does; the window is always on screen, so an idle loop would waste power.
export function useShellMotion(input: MotionInput): ShellMotion {
  const { open, keys, windowWidth } = input;
  const [layers] = useState<Layers>(() => ({
    shape: createRef<HTMLDivElement>(),
    content: createRef<HTMLElement>(),
    word: createRef<HTMLDivElement>(),
    rim: createRef<SVGSVGElement>(),
  }));
  const latest = useRef(input);
  latest.current = input;
  const [runner] = useState<Runner>(() => ({
    frame: restingFrame(keys.collapsed, false, keys.pill),
    path: "",
    motion: null,
    raf: null,
    open: false,
  }));

  useLayoutEffect(() => {
    draw(runner, windowWidth, layers);
  }, [runner, windowWidth, layers]);

  useEffect(() => {
    const step = (now: number) => {
      const motion = runner.motion;
      if (motion === null) return;
      runner.frame = sample(motion, now);
      draw(runner, windowWidth, layers);
      latest.current.onFrame();
      if (now < motionEnd(motion)) {
        runner.raf = requestAnimationFrame(step);
        return;
      }
      runner.motion = null;
      runner.raf = null;
      latest.current.onSettled(open);
    };
    runner.motion = plan(runner, latest.current);
    if (runner.raf !== null) cancelAnimationFrame(runner.raf);
    runner.raf = requestAnimationFrame(step);
    return () => {
      if (runner.raf !== null) cancelAnimationFrame(runner.raf);
      runner.raf = null;
    };
  }, [runner, open, keys, windowWidth, layers]);

  return { layers, visiblePath: () => runner.path };
}
