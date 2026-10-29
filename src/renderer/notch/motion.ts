import type { Silhouette } from "./outline";

export type Ease = (progress: number) => number;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const linear: Ease = (progress) => clamp01(progress);

// CSS cubic-bezier(x1, y1, x2, y2): finds the curve's t for the time, then returns its value.
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) =>
    3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t ** 2 + t ** 3;
  const ease: Ease = (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    let low = 0;
    let high = 1;
    for (let step = 0; step < 32; step += 1) {
      const middle = (low + high) / 2;
      if (at(x1, x2, middle) < progress) low = middle;
      else high = middle;
    }
    return at(y1, y2, (low + high) / 2);
  };
  return ease;
}

// The progress at which a rising ease reaches the value, so a reversed motion continues its curve.
export function progressAt(ease: Ease, value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 32; step += 1) {
    const middle = (low + high) / 2;
    if (ease(middle) < value) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

// What the shell draws: the silhouette, the content's opacity, and the whole shape's opacity (reduced motion fades it).
export type Frame = Silhouette & { content: number; shade: number };
type Channel = keyof Frame;

// skip: time already spent on this curve, so a motion that starts part way keeps its speed and never jumps.
export type Track = {
  from: number;
  to: number;
  delay: number;
  duration: number;
  skip: number;
  ease: Ease;
};

export type Motion = {
  startedAt: number;
  tracks: Record<Channel, Track>;
  end: Frame; // drawn once every track has finished
};

const channels: Channel[] = [
  "width",
  "height",
  "ear",
  "rx",
  "ry",
  "content",
  "shade",
];

function trackEnd(track: Track): number {
  return track.delay + Math.max(0, track.duration - track.skip);
}

export function motionEnd(motion: Motion): number {
  const ends = channels.map((channel) => trackEnd(motion.tracks[channel]));
  return motion.startedAt + Math.max(0, ...ends);
}

function trackValue(track: Track, elapsed: number): number {
  const { from, to, delay, duration, skip, ease } = track;
  if (elapsed < delay) return from;
  if (duration <= 0) return to;
  const start = ease(clamp01(skip / duration));
  if (start >= 1) return to;
  const now = ease(clamp01((elapsed - delay + skip) / duration));
  return from + ((to - from) * (now - start)) / (1 - start);
}

export function sample(motion: Motion, now: number): Frame {
  if (now >= motionEnd(motion)) return motion.end;
  const elapsed = now - motion.startedAt;
  const frame = { ...motion.end };
  for (const channel of channels) {
    frame[channel] = trackValue(motion.tracks[channel], elapsed);
  }
  return frame;
}

export function restingFrame(shape: Silhouette, open: boolean): Frame {
  return { ...shape, content: open ? 1 : 0, shade: 1 };
}

type Timing = Omit<Track, "from" | "to">;

function tracksFor(
  from: Frame,
  to: Frame,
  timing: { shape: Timing; content: Timing; shade: Timing },
): Record<Channel, Track> {
  const track = (channel: Channel, part: Timing): Track => ({
    from: from[channel],
    to: to[channel],
    ...part,
  });
  return {
    width: track("width", timing.shape),
    height: track("height", timing.shape),
    ear: track("ear", timing.shape),
    rx: track("rx", timing.shape),
    ry: track("ry", timing.shape),
    content: track("content", timing.content),
    shade: track("shade", timing.shade),
  };
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
} as const;

export type PanelKeys = { collapsed: Silhouette; opened: Silhouette };

// How far the shape is from collapsed (0) to open (1), by height.
function openness(current: Frame, keys: PanelKeys): number {
  const span = keys.opened.height - keys.collapsed.height;
  if (span <= 0) return 1;
  return (current.height - keys.collapsed.height) / span;
}

const instant: Timing = { delay: 0, duration: 0, skip: 0, ease: linear };

function planOpen(current: Frame, keys: PanelKeys): Motion["tracks"] {
  const t = panelTiming;
  // Taller than the target (the content shrank): the curve starts afresh.
  const done = openness(current, keys);
  const skip = done > 1 ? 0 : progressAt(t.openEase, clamp01(done)) * t.openMs;
  const target = restingFrame(keys.opened, true);
  return tracksFor(current, target, {
    shape: { delay: 0, duration: t.openMs, skip, ease: t.openEase },
    content: {
      // A shape already at full size lets the content come back at once.
      delay: done >= 1 ? 0 : Math.max(0, t.contentDelayMs - skip),
      duration: t.contentMs,
      skip: current.content * t.contentMs,
      ease: linear,
    },
    shade: instant,
  });
}

function planClose(current: Frame, keys: PanelKeys): Motion["tracks"] {
  const t = panelTiming;
  const closedness = 1 - clamp01(openness(current, keys));
  const fadeLeft = current.content * t.closeContentMs;
  const skip = progressAt(t.closeEase, closedness) * t.closeMs;
  const target = restingFrame(keys.collapsed, false);
  return tracksFor(current, target, {
    shape: { delay: fadeLeft, duration: t.closeMs, skip, ease: t.closeEase },
    content: {
      delay: 0,
      duration: t.closeContentMs,
      skip: (1 - current.content) * t.closeContentMs,
      ease: linear,
    },
    shade: instant,
  });
}

// Reduced motion: no grow. The open panel fades in over the notch, and fades out before the notch comes back.
function planReduced(
  current: Frame,
  keys: PanelKeys,
  open: boolean,
): Motion["tracks"] {
  const t = panelTiming;
  // In reduced motion the content shows exactly while the open shape does.
  const shown = current.content > 0 ? current.shade : 0;
  if (open) {
    const from = { ...current, shade: shown };
    return tracksFor(from, restingFrame(keys.opened, true), {
      shape: instant,
      content: instant,
      shade: {
        ...instant,
        duration: t.reducedInMs,
        skip: shown * t.reducedInMs,
      },
    });
  }
  const fadeLeft = shown * t.reducedOutMs;
  const from = { ...current, shade: shown };
  const at = { ...instant, delay: fadeLeft };
  return tracksFor(
    from,
    { ...restingFrame(keys.collapsed, false), shade: 0 },
    {
      shape: at,
      content: at,
      shade: {
        ...instant,
        duration: t.reducedOutMs,
        skip: t.reducedOutMs - fadeLeft,
      },
    },
  );
}

export function planPanel(
  current: Frame,
  keys: PanelKeys,
  how: { open: boolean; reduced: boolean; now: number },
): Motion {
  const { open, reduced, now } = how;
  const tracks = reduced
    ? planReduced(current, keys, open)
    : open
      ? planOpen(current, keys)
      : planClose(current, keys);
  const end = restingFrame(open ? keys.opened : keys.collapsed, open);
  return { startedAt: now, tracks, end };
}
