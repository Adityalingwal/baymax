import {
  clamp01,
  cubicBezier,
  easeOutCubic,
  instant,
  linear,
  makeMotion,
  progressAt,
} from "./motion";
import type { Frame, Motion, Timing } from "./motion";
import type { Silhouette } from "./outline";
import type { ClosedView } from "./views";

// Which layers show at rest: the panel's content when open; the word and lines on the pill; the word and card on the island, its report open or not; the ring.
export function restingFrame(
  shape: Silhouette,
  view: ClosedView | "open",
): Frame {
  const on = (shows: boolean) => (shows ? 1 : 0);
  const onIsland = view === "island" || view === "report";
  const voice = view === "pill" || onIsland;
  const { hidden, ...outline } = shape;
  return {
    ...outline,
    content: on(view === "open"),
    shade: on(hidden !== true),
    pill: on(voice),
    rim: on(view === "pill"),
    card: on(onIsland),
    ring: on(view === "ring"),
  };
}

// How long the panel takes to open and close.
export const panelTiming = {
  openMs: 360,
  openEase: cubicBezier(0.22, 1, 0.36, 1),
  contentDelayMs: 90,
  contentMs: 180,
  closeContentMs: 80,
  closeMs: 260, // shared with the pill's silent close
  closeEase: cubicBezier(0.4, 0, 1, 1),
  resizeMs: 260,
  reducedInMs: 120,
  reducedOutMs: 100,
  slide: 4,
  landingMs: 140, // the closed shape's own layers coming back as the panel lands on it
} as const;

export type PanelKeys = {
  collapsed: Silhouette;
  opened: Silhouette;
  view: ClosedView; // what the panel closes onto
};

// How far the shape is from collapsed (0) to open (1), by height.
function openness(current: Frame, keys: PanelKeys): number {
  const span = keys.opened.height - keys.collapsed.height;
  if (span <= 0) return 1;
  return (current.height - keys.collapsed.height) / span;
}

// A shape closing onto the hidden notch stays drawn until its last frame; going from hidden to hidden it never draws.
export function whileMoving(current: Frame, target: Frame): Frame {
  const hidden = current.shade === 0 && target.shade === 0;
  return { ...target, shade: hidden ? 0 : 1 };
}

// A fade from the current value: skip is the part already done, so a turned-around fade keeps its pace.
export function fade(
  duration: number,
  from: number,
  to: number,
  delay = 0,
): Timing {
  const done = to > from ? from : 1 - from;
  return { delay, duration, skip: clamp01(done) * duration, ease: linear };
}

function planOpen(current: Frame, keys: PanelKeys, now: number): Motion {
  const t = panelTiming;
  // Taller than the target (the content shrank): the curve starts afresh.
  const done = openness(current, keys);
  const skip = done > 1 ? 0 : progressAt(t.openEase, clamp01(done)) * t.openMs;
  // A shape already at full size lets the content come back at once.
  const contentDelay = done >= 1 ? 0 : Math.max(0, t.contentDelayMs - skip);
  const out = (from: number) => fade(t.closeContentMs, from, 0);
  return makeMotion(
    current,
    restingFrame(keys.opened, "open"),
    {
      shape: { delay: 0, duration: t.openMs, skip, ease: t.openEase },
      content: fade(t.contentMs, current.content, 1, contentDelay),
      shade: instant,
      pill: out(current.pill),
      rim: out(current.rim),
      card: out(current.card),
      ring: out(current.ring),
    },
    { now },
  );
}

// The open panel's size following its content.
export function planResize(
  current: Frame,
  keys: PanelKeys,
  now: number,
): Motion {
  const t = panelTiming;
  const out = (from: number) => fade(t.closeContentMs, from, 0);
  return makeMotion(
    current,
    restingFrame(keys.opened, "open"),
    {
      shape: { delay: 0, duration: t.resizeMs, skip: 0, ease: easeOutCubic },
      content: fade(t.contentMs, current.content, 1),
      shade: instant,
      pill: out(current.pill),
      rim: out(current.rim),
      card: out(current.card),
      ring: out(current.ring),
    },
    { now },
  );
}

function planClose(current: Frame, keys: PanelKeys, now: number): Motion {
  const t = panelTiming;
  const closedness = 1 - clamp01(openness(current, keys));
  const fadeLeft = current.content * t.closeContentMs;
  const skip = progressAt(t.closeEase, closedness) * t.closeMs;
  const target = restingFrame(keys.collapsed, keys.view);
  const landing = fadeLeft + Math.max(0, t.closeMs - skip - t.landingMs);
  const back = (from: number, to: number) =>
    fade(t.landingMs, from, to, landing);
  return makeMotion(
    current,
    whileMoving(current, target),
    {
      shape: { delay: fadeLeft, duration: t.closeMs, skip, ease: t.closeEase },
      content: fade(t.closeContentMs, current.content, 0),
      shade: instant,
      pill: back(current.pill, target.pill),
      rim: back(current.rim, target.rim),
      card: back(current.card, target.card),
      ring: back(current.ring, target.ring),
    },
    { now, end: target },
  );
}

// Reduced motion: no grow. The open panel fades in over the notch, and fades out before the notch comes back.
function planReduced(
  current: Frame,
  keys: PanelKeys,
  how: { open: boolean; now: number },
): Motion {
  const t = panelTiming;
  // In reduced motion the content shows exactly while the open shape does.
  const shown = current.content > 0 ? current.shade : 0;
  const from = { ...current, shade: shown };
  if (how.open) {
    const skip = shown * t.reducedInMs;
    const shade = { ...instant, duration: t.reducedInMs, skip };
    const swaps = { content: instant, pill: instant, rim: instant };
    const timings = { ...swaps, card: instant, ring: instant };
    const target = restingFrame(keys.opened, "open");
    return makeMotion(
      from,
      target,
      { ...timings, shape: instant, shade },
      { now: how.now },
    );
  }
  const fadeLeft = shown * t.reducedOutMs;
  const at = { ...instant, delay: fadeLeft };
  const end = restingFrame(keys.collapsed, keys.view);
  const skip = t.reducedOutMs - fadeLeft;
  const shade = { ...instant, duration: t.reducedOutMs, skip };
  const layers = { pill: at, rim: at, card: at, ring: at };
  const timings = { ...layers, shape: at, content: at, shade };
  return makeMotion(from, { ...end, shade: 0 }, timings, { now: how.now, end });
}

export function planPanel(
  current: Frame,
  keys: PanelKeys,
  how: { open: boolean; reduced: boolean; now: number },
): Motion {
  const { open, reduced, now } = how;
  if (reduced) return planReduced(current, keys, { open, now });
  return open ? planOpen(current, keys, now) : planClose(current, keys, now);
}
