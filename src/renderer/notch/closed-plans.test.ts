import { describe, expect, it } from "vitest";
import { closedTiming, easeOutCubic, planClosed } from "./closed-plans";
import { motionEnd, sample } from "./motion";
import type { Frame } from "./motion";
import type { Silhouette } from "./outline";
import { restingFrame } from "./plans";
import type { ClosedView } from "./views";

const notch = { width: 139, height: 25, ear: 0, rx: 0, ry: 0 };
const ring = { width: 175, height: 25, ear: 6, rx: 10, ry: 10 };
const pill = { width: 360, height: 32, ear: 6, rx: 24, ry: 26 };
const island = { width: 480, height: 110, ear: 6, rx: 26, ry: 28 };
const taller = { ...island, height: 140 };

const to = (from: Frame, view: ClosedView, shape: Silhouette, now = 0) =>
  planClosed(from, { view, shape }, { reduced: false, now });

describe("easeOutCubic", () => {
  it.each([
    { at: 0, value: 0 },
    { at: 0.5, value: 0.875 },
    { at: 1, value: 1 },
  ])("is $value at $at", ({ at, value }) => {
    expect(easeOutCubic(at)).toBeCloseTo(value);
  });
});

describe("the answer island's grow", () => {
  const motion = to(restingFrame(pill, "pill"), "island", island);

  it("widens over 0–330 ms, then grows taller over 225–720 ms", () => {
    expect(sample(motion, 225).height).toBe(32);
    expect(sample(motion, 330).width).toBe(480);
    expect(sample(motion, 330).height).toBeGreaterThan(32);
    expect(motionEnd(motion)).toBe(720);
    expect(sample(motion, 720)).toEqual(restingFrame(island, "island"));
  });

  it("fades the card in over 360–630 ms and the corner lines with the height", () => {
    expect(sample(motion, 360).card).toBe(0);
    expect(sample(motion, 630).card).toBe(1);
    expect(sample(motion, 225).rim).toBe(1);
    expect(sample(motion, 720).rim).toBe(0);
    expect(sample(motion, 500).pill).toBe(1);
  });

  it("waits for the ring to fade out first", () => {
    const fromRing = to(restingFrame(ring, "ring"), "island", island);
    expect(sample(fromRing, 70).ring).toBeCloseTo(0.5);
    expect(sample(fromRing, closedTiming.ringMs).width).toBe(175);
    expect(motionEnd(fromRing)).toBe(closedTiming.ringMs + 720);
  });
});

describe("the closed shape turns around from where it is", () => {
  it.each<{
    name: string;
    first: () => ReturnType<typeof to>;
    at: number;
    view: ClosedView;
    shape: Silhouette;
  }>([
    {
      name: "a new answer line during the grow",
      first: () => to(restingFrame(pill, "pill"), "island", island),
      at: 400,
      view: "island",
      shape: taller,
    },
    {
      name: "a new answer line during the close",
      first: () => to(restingFrame(island, "island"), "notch", notch),
      at: 200,
      view: "island",
      shape: island,
    },
    {
      name: "the line ending during the grow",
      first: () => to(restingFrame(pill, "pill"), "island", island),
      at: 300,
      view: "notch",
      shape: notch,
    },
  ])("$name", ({ first, at, view, shape }) => {
    const current = sample(first(), at);
    const next = sample(to(current, view, shape, at), at);
    for (const channel of ["width", "height", "card", "pill", "rim"] as const) {
      expect(next[channel]).toBeCloseTo(current[channel], 6);
    }
  });
});

describe("the island's close and the ring", () => {
  it("closes the island softly: content out in 140 ms, shape in 420 ms", () => {
    const motion = to(restingFrame(island, "island"), "notch", notch);
    expect(sample(motion, 140)).toMatchObject({ card: 0, pill: 0 });
    expect(sample(motion, 420)).toEqual(restingFrame(notch, "notch"));
  });

  it("closes the island back to the ring while tasks still run", () => {
    const motion = to(restingFrame(island, "island"), "ring", ring);
    expect(sample(motion, 280).ring).toBe(0);
    expect(sample(motion, 420)).toEqual(restingFrame(ring, "ring"));
  });

  it("grows the ring from the notch in 420 ms, the ring fading in over the last 140 ms", () => {
    const motion = to(restingFrame(notch, "notch"), "ring", ring);
    expect(sample(motion, 280).ring).toBe(0);
    expect(sample(motion, 350).ring).toBeCloseTo(0.5);
    expect(motionEnd(motion)).toBe(420);
  });

  it("fades the ring out before the pill grows", () => {
    const motion = to(restingFrame(ring, "ring"), "pill", pill);
    expect(sample(motion, closedTiming.ringMs)).toMatchObject({
      width: 175,
      ring: 0,
    });
    expect(motionEnd(motion)).toBe(closedTiming.ringMs + 420);
  });

  it("with reduced motion swaps at once", () => {
    const motion = planClosed(
      restingFrame(pill, "pill"),
      { view: "island", shape: island },
      { reduced: true, now: 0 },
    );
    expect(sample(motion, 0)).toEqual(restingFrame(island, "island"));
  });
});
