import { createRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { planClosed } from "./closed-plans";
import { motionEnd, sample } from "./motion";
import type { Frame, Motion } from "./motion";
import { silhouettePath } from "./outline";
import type { PillClose } from "./pill";
import { panelTiming, planPanel, planResize, restingFrame } from "./plans";
import type { PanelKeys } from "./plans";
import type { ClosedView } from "./views";
import type { VoiceLayers } from "./VoicePill";

type Runner = {
  frame: Frame;
  path: string;
  motion: Motion | null;
  raf: number | null;
  open: boolean; // the open state the last motion was planned for
  view: ClosedView; // the closed view the last motion was planned for
};

export type Layers = VoiceLayers & {
  shape: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLElement | null>;
  card: RefObject<HTMLButtonElement | null>;
  ring: RefObject<HTMLDivElement | null>;
};

export type ShellMotion = {
  layers: Layers;
  visiblePath: () => string; // the shape as drawn now, for hit-testing
};

type MotionInput = {
  open: boolean;
  keys: PanelKeys;
  pillClose: PillClose;
  windowWidth: number;
  onFrame: () => void;
  onSettled: (open: boolean) => void;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Styled = HTMLElement | SVGElement | null;

function setOpacity(element: Styled, value: number, slide = 0) {
  if (element === null) return;
  element.style.opacity = String(value);
  if (slide !== 0) {
    element.style.transform = `translateY(${(1 - value) * slide}px)`;
  }
}

// Written straight to the elements: a React render per frame would be too slow for a 60 fps shape.
function draw(runner: Runner, windowWidth: number, layers: Layers): void {
  const { frame } = runner;
  const path = silhouettePath(windowWidth, frame);
  // A shape not drawn takes no clicks: the empty path hits nothing.
  runner.path = frame.shade === 0 ? "" : path;
  const shape = layers.shape.current;
  if (shape !== null) shape.style.clipPath = `path("${path}")`;
  setOpacity(shape, frame.shade);
  setOpacity(layers.content.current, frame.content, -panelTiming.slide);
  const voice = layers.voice.current;
  if (voice !== null) {
    voice.style.left = `${(windowWidth - frame.width) / 2}px`;
    voice.style.width = `${frame.width}px`;
    voice.style.height = `${frame.height}px`;
  }
  setOpacity(layers.word.current, frame.pill);
  setOpacity(layers.rim.current, frame.rim);
  setOpacity(layers.card.current, frame.card, 4);
  setOpacity(layers.ring.current, frame.ring);
}

// The panel opening or closing moves on the panel's curves; the closed shape changing moves on its own.
function plan(runner: Runner, input: MotionInput): Motion {
  const { open, keys } = input;
  const how = { reduced: prefersReducedMotion(), now: performance.now() };
  const wasOpen = runner.open;
  // The pill's close applies only to the pill: the state keeps it after it is used.
  const close = runner.view === "pill" ? input.pillClose : "soft";
  runner.open = open;
  runner.view = keys.view;
  if (open && wasOpen && !how.reduced) {
    return planResize(runner.frame, keys, how.now);
  }
  if (open || wasOpen) return planPanel(runner.frame, keys, { ...how, open });
  const target = { view: keys.view, shape: keys.collapsed, close };
  return planClosed(runner.frame, target, how);
}

function createLayers(): Layers {
  return {
    shape: createRef<HTMLDivElement>(),
    content: createRef<HTMLElement>(),
    voice: createRef<HTMLDivElement>(),
    word: createRef<HTMLDivElement>(),
    rim: createRef<HTMLDivElement>(),
    card: createRef<HTMLButtonElement>(),
    ring: createRef<HTMLDivElement>(),
  };
}

// One frame loop that runs only while a motion does; the window is always on screen, so an idle loop would waste power.
export function useShellMotion(input: MotionInput): ShellMotion {
  const { open, keys, windowWidth } = input;
  // Only the shape being shown re-plans: the panel's size while open, the closed shape while closed.
  const target = open ? keys.opened : keys.collapsed;
  const [layers] = useState<Layers>(createLayers);
  const latest = useRef(input);
  latest.current = input;
  const [runner] = useState<Runner>(() => ({
    frame: restingFrame(keys.collapsed, keys.view),
    path: "",
    motion: null,
    raf: null,
    open: false,
    view: keys.view,
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
  }, [runner, open, target, keys.view, windowWidth, layers]);

  return { layers, visiblePath: () => runner.path };
}
