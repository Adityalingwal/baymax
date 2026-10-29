import type { Silhouette } from "./outline";

export type Ease = (progress: number) => number;

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const linear: Ease = (progress) => clamp01(progress);

// The locked soft curve: clamped quintic smootherstep, zero speed and acceleration at both ends.
export const smootherstep: Ease = (progress) => {
  const t = clamp01(progress);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

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

// What the shell draws: the silhouette, then opacities: the panel content, the whole shape (reduced motion fades it),
// the pill's word and mute button, and the pill's corner lines.
export type Frame = Silhouette & {
  content: number;
  shade: number;
  pill: number;
  rim: number;
};
export type Channel = keyof Frame;

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
  "pill",
  "rim",
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

export type Timing = Omit<Track, "from" | "to">;

export const instant: Timing = { delay: 0, duration: 0, skip: 0, ease: linear };

// One timing per group; a channel may have its own instead.
export type Timings = {
  shape: Timing;
  content: Timing;
  shade: Timing;
  pill: Timing;
  rim: Timing;
} & Partial<Record<Channel, Timing>>;

type Group = "shape" | "content" | "shade" | "pill" | "rim";

const groupOf: Record<Channel, Group> = {
  width: "shape",
  height: "shape",
  ear: "shape",
  rx: "shape",
  ry: "shape",
  content: "content",
  shade: "shade",
  pill: "pill",
  rim: "rim",
};

// end: what stays once the motion is over, when it differs from where the tracks go.
export function makeMotion(
  from: Frame,
  to: Frame,
  timings: Timings,
  how: { now: number; end?: Frame },
): Motion {
  const track = (channel: Channel): Track => ({
    from: from[channel],
    to: to[channel],
    ...(timings[channel] ?? timings[groupOf[channel]]),
  });
  const tracks = {
    width: track("width"),
    height: track("height"),
    ear: track("ear"),
    rx: track("rx"),
    ry: track("ry"),
    content: track("content"),
    shade: track("shade"),
    pill: track("pill"),
    rim: track("rim"),
  };
  return { startedAt: how.now, tracks, end: how.end ?? to };
}
