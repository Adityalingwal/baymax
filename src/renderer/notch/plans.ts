import {
  clamp01,
  cubicBezier,
  instant,
  linear,
  makeMotion,
  progressAt,
  smootherstep,
} from "./motion";
import type { Frame, Motion, Timing } from "./motion";
import type { Silhouette } from "./outline";

// pill: the closed shape is the voice pill, so its word and corner lines show.
export function restingFrame(
  shape: Silhouette,
  open: boolean,
  pill = false,
): Frame {
  const shown = !open && pill ? 1 : 0;
  return { ...shape, content: open ? 1 : 0, shade: 1, pill: shown, rim: shown };
}

// Timings from the locked design: notch-design-locked.md, "Panel close and motion".
export const panelTiming = {
  openMs: 360,
  openEase: cubicBezier(0.22, 1, 0.36, 1),
  contentDelayMs: 90,
  contentMs: 180,
  closeContentMs: 80,
  closeMs: 220,
  closeEase: cubicBezier(0.4, 0, 1, 1),
  reducedInMs: 120,
  reducedOutMs: 100,
  slide: 4,
  pillFadeMs: 140, // the pill's word coming back as the panel lands on it
} as const;

export type PanelKeys = {
  collapsed: Silhouette;
  opened: Silhouette;
  pill: boolean; // the collapsed shape is the voice pill
};

// How far the shape is from collapsed (0) to open (1), by height.
function openness(current: Frame, keys: PanelKeys): number {
  const span = keys.opened.height - keys.collapsed.height;
  if (span <= 0) return 1;
  return (current.height - keys.collapsed.height) / span;
}

// A fade from the current value: skip is the part already done, so a turned-around fade keeps its pace.
function fade(duration: number, from: number, to: number, delay = 0): Timing {
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
  return makeMotion(
    current,
    restingFrame(keys.opened, true),
    {
      shape: { delay: 0, duration: t.openMs, skip, ease: t.openEase },
      content: fade(t.contentMs, current.content, 1, contentDelay),
      shade: instant,
      pill: fade(t.closeContentMs, current.pill, 0),
      rim: fade(t.closeContentMs, current.rim, 0),
    },
    { now },
  );
}

function planClose(current: Frame, keys: PanelKeys, now: number): Motion {
  const t = panelTiming;
  const closedness = 1 - clamp01(openness(current, keys));
  const fadeLeft = current.content * t.closeContentMs;
  const skip = progressAt(t.closeEase, closedness) * t.closeMs;
  const target = restingFrame(keys.collapsed, false, keys.pill);
  const landing = fadeLeft + Math.max(0, t.closeMs - skip - t.pillFadeMs);
  return makeMotion(
    current,
    target,
    {
      shape: { delay: fadeLeft, duration: t.closeMs, skip, ease: t.closeEase },
      content: fade(t.closeContentMs, current.content, 0),
      shade: instant,
      pill: fade(t.pillFadeMs, current.pill, target.pill, landing),
      rim: fade(t.pillFadeMs, current.rim, target.rim, landing),
    },
    { now },
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
  const swaps = { content: instant, pill: instant, rim: instant };
  if (how.open) {
    const skip = shown * t.reducedInMs;
    const shade = { ...instant, duration: t.reducedInMs, skip };
    const target = restingFrame(keys.opened, true);
    const timings = { ...swaps, shape: instant, shade };
    return makeMotion(from, target, timings, { now: how.now });
  }
  const fadeLeft = shown * t.reducedOutMs;
  const at = { ...instant, delay: fadeLeft };
  const end = restingFrame(keys.collapsed, false, keys.pill);
  const skip = t.reducedOutMs - fadeLeft;
  const shade = { ...instant, duration: t.reducedOutMs, skip };
  const timings = { shape: at, content: at, pill: at, rim: at, shade };
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

// Timings from the locked design: "Voice pill" and "Closed-panel voice pill: Soft close".
export const pillTiming = { shapeMs: 420, wordMs: 140, rimMs: 180 } as const;

export type PillKeys = { notch: Silhouette; pill: Silhouette };

const soft = (duration: number, from: number, to: number, delay = 0) => ({
  ...fade(duration, from, to, delay),
  ease: smootherstep,
});

// The pill grows out of the notch and shrinks back into it on the same soft curve, turning around from where it is.
export function planPill(
  current: Frame,
  keys: PillKeys,
  how: { shown: boolean; reduced: boolean; now: number },
): Motion {
  const { shown, reduced, now } = how;
  const target = shown
    ? restingFrame(keys.pill, false, true)
    : restingFrame(keys.notch, false);
  const still = { content: instant, shade: instant };
  if (reduced) {
    const timings = { ...still, shape: instant, pill: instant, rim: instant };
    return makeMotion(current, target, timings, { now });
  }
  const t = pillTiming;
  const span = keys.pill.width - keys.notch.width;
  const width = current.width - keys.notch.width;
  const grown = span <= 0 ? 1 : clamp01(width / span);
  const skip = progressAt(smootherstep, shown ? grown : 1 - grown) * t.shapeMs;
  // Growing, the word comes in over the last 140 ms; shrinking, the word and the lines fade first.
  const wordDelay = shown ? Math.max(0, t.shapeMs - t.wordMs - skip) : 0;
  const rimMs = shown ? t.wordMs : t.rimMs;
  const timings = {
    ...still,
    shape: { delay: 0, duration: t.shapeMs, skip, ease: smootherstep },
    pill: soft(t.wordMs, current.pill, target.pill, wordDelay),
    rim: soft(rimMs, current.rim, target.rim),
  };
  return makeMotion(current, target, timings, { now });
}
