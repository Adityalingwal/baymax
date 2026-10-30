import { easeOutCubic, instant, makeMotion, smootherstep } from "./motion";
import type { Frame, Motion, Timing } from "./motion";
import type { Silhouette } from "./outline";
import type { PillClose } from "./pill";
import { fade, panelTiming, restingFrame, whileMoving } from "./plans";
import type { ClosedView } from "./views";

// Timings from the locked design: "Voice pill", "Closed-panel voice pill: Soft close", "Running task: spinning ring",
// "Answer island grow", "Report expand/fold", and design-lock-timing.md. The island's close is not locked; it uses the "Two results together" close (140 ms content, 420 ms shape).
export const closedTiming = {
  shapeMs: 420,
  pillGrowMs: 200,
  silentCloseMs: panelTiming.closeMs,
  wordMs: 140,
  rimMs: 180,
  ringMs: 140,
  island: {
    widthMs: 330,
    heightDelayMs: 225,
    heightMs: 495,
    cardDelayMs: 360,
    cardMs: 270,
  },
  report: {
    totalMs: 720,
    widthMs: 396,
    heightDelayMs: 115.2,
    heightMs: 604.8,
  },
} as const;

const soft = (duration: number, from: number, to: number, delay = 0) => ({
  ...fade(duration, from, to, delay),
  ease: smootherstep,
});

// Width first, then the height (with the corners and the fading corner lines), then the card; the ring fades out before any of it.
function planIsland(current: Frame, target: Frame, now: number): Motion {
  const t = closedTiming;
  const lead = current.ring * t.ringMs;
  const at = (delay: number, duration: number): Timing => ({
    delay: lead + delay,
    duration,
    skip: 0,
    ease: easeOutCubic,
  });
  const height = at(t.island.heightDelayMs, t.island.heightMs);
  const timings = {
    shape: height,
    width: at(0, t.island.widthMs),
    content: instant,
    shade: instant,
    pill: soft(t.wordMs, current.pill, target.pill, lead),
    rim: height,
    card: at(t.island.cardDelayMs, t.island.cardMs),
    ring: soft(t.ringMs, current.ring, 0),
  };
  return makeMotion(current, target, timings, { now });
}

// Only the shape moves: width first when opening, and the same path in reverse when folding.
function planReport(
  current: Frame,
  target: Frame,
  how: { folding: boolean; now: number },
): Motion {
  const { totalMs, widthMs, heightDelayMs, heightMs } = closedTiming.report;
  const at = (delay: number, duration: number): Timing => ({
    delay,
    duration,
    skip: 0,
    ease: smootherstep,
  });
  const { folding, now } = how;
  const timings = {
    shape: folding ? at(0, heightMs) : at(heightDelayMs, heightMs),
    width: folding ? at(totalMs - widthMs, widthMs) : at(0, widthMs),
    content: instant,
    shade: instant,
    pill: instant,
    rim: instant,
    card: instant,
    ring: instant,
  };
  return makeMotion(current, target, timings, { now });
}

function softMs(view: ClosedView, close: PillClose): number {
  const t = closedTiming;
  if (view === "pill") return t.pillGrowMs;
  return close === "silent" ? t.silentCloseMs : t.shapeMs;
}

// Arriving layers come in over the last 140 ms of the shape; leaving ones fade from its start (the word and the ring in 140 ms, the lines in 180 ms).
function planSoft(
  current: Frame,
  target: Frame,
  how: { view: ClosedView; close: PillClose; now: number },
): Motion {
  const t = closedTiming;
  const { view, now } = how;
  const shapeMs = softMs(view, how.close);
  const late = shapeMs - t.wordMs;
  const layer = (from: number, to: number, outMs: number, inDelay: number) =>
    to > from ? soft(t.wordMs, from, to, inDelay) : soft(outMs, from, to);
  const timings = {
    shape: { delay: 0, duration: shapeMs, skip: 0, ease: smootherstep },
    content: instant,
    shade: instant,
    pill: layer(current.pill, target.pill, t.wordMs, late),
    rim: layer(current.rim, target.rim, t.rimMs, 0),
    card: layer(current.card, target.card, t.wordMs, late),
    ring: layer(current.ring, target.ring, t.ringMs, late),
  };
  return makeMotion(current, whileMoving(current, target), timings, {
    now,
    end: target,
  });
}

// The closed shape moving between the notch, the ring, the pill and the island; it always starts from the frame drawn now.
export function planClosed(
  current: Frame,
  target: {
    view: ClosedView;
    shape: Silhouette;
    close?: PillClose;
    folding?: boolean; // the report is folding back to the plain island
  },
  how: { reduced: boolean; now: number },
): Motion {
  const { view, shape, close = "soft", folding = false } = target;
  const rest = restingFrame(shape, view);
  if (how.reduced) {
    const swaps = { content: instant, shade: instant, pill: instant };
    const layers = { rim: instant, card: instant, ring: instant };
    const timings = { ...swaps, ...layers, shape: instant };
    return makeMotion(current, rest, timings, { now: how.now });
  }
  if (view === "report" || folding) {
    return planReport(current, rest, { folding, now: how.now });
  }
  return view === "island"
    ? planIsland(current, rest, how.now)
    : planSoft(current, rest, { view, close, now: how.now });
}
