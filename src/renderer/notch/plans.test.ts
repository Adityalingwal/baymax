import { describe, expect, it } from "vitest";
import { motionEnd, sample, smootherstep } from "./motion";
import { pillTiming, planPanel, planPill, restingFrame } from "./plans";

const notch = { width: 139, height: 25, ear: 0, rx: 0, ry: 0 };
const pill = { width: 360, height: 32, ear: 6, rx: 24, ry: 26 };
const opened = { width: 628, height: 300, ear: 6, rx: 26, ry: 28 };
const keys = { notch, pill };
const atNotch = restingFrame(notch, false);
const atPill = restingFrame(pill, false, true);

const grow = (reduced = false) =>
  planPill(atNotch, keys, { shown: true, reduced, now: 0 });
const shrink = (reduced = false) =>
  planPill(atPill, keys, { shown: false, reduced, now: 0 });

describe("smootherstep", () => {
  it.each([
    { at: 0, value: 0 },
    { at: 0.5, value: 0.5 },
    { at: 1, value: 1 },
    { at: 2, value: 1 },
  ])("is $value at $at", ({ at, value }) => {
    expect(smootherstep(at)).toBeCloseTo(value);
  });
});

describe("planPill", () => {
  it("grows the pill out of the notch in 420 ms, the word arriving last", () => {
    const motion = grow();
    expect(sample(motion, 210).width).toBeCloseTo(249.5);
    expect(sample(motion, 280).pill).toBe(0);
    expect(sample(motion, 350).pill).toBeCloseTo(0.5);
    expect(motionEnd(motion)).toBe(pillTiming.shapeMs);
    expect(sample(motion, 420)).toEqual(atPill);
  });

  it("closes softly: the word fades in 140 ms, the lines in 180 ms, the shape in 420 ms", () => {
    const motion = shrink();
    expect(sample(motion, 70).pill).toBeCloseTo(0.5);
    expect(sample(motion, 140).pill).toBe(0);
    expect(sample(motion, 90).rim).toBeCloseTo(0.5);
    expect(sample(motion, 180).rim).toBe(0);
    expect(sample(motion, 210).width).toBeCloseTo(249.5);
    expect(sample(motion, 420)).toEqual(atNotch);
  });

  it("turns a close around from where it is", () => {
    const current = sample(shrink(), 300);
    const reopened = planPill(current, keys, {
      shown: true,
      reduced: false,
      now: 300,
    });
    expect(sample(reopened, 300).width).toBeCloseTo(current.width, 6);
    expect(motionEnd(reopened)).toBeLessThan(300 + pillTiming.shapeMs);
  });

  it.each([
    { name: "grow", motion: () => grow(true), end: atPill },
    { name: "close", motion: () => shrink(true), end: atNotch },
  ])("with reduced motion swaps at once: $name", ({ motion, end }) => {
    expect(sample(motion(), 0)).toEqual(end);
  });
});

describe("planPanel with the pill", () => {
  const panelKeys = { collapsed: pill, opened, pill: true };

  it("hides the pill's word as the panel opens over it", () => {
    const motion = planPanel(atPill, panelKeys, {
      open: true,
      reduced: false,
      now: 0,
    });
    expect(sample(motion, 80)).toMatchObject({ pill: 0, rim: 0 });
  });

  it("lands back on the pill with its word", () => {
    const from = restingFrame(opened, true);
    const motion = planPanel(from, panelKeys, {
      open: false,
      reduced: false,
      now: 0,
    });
    expect(sample(motion, 150).pill).toBe(0);
    expect(sample(motion, motionEnd(motion))).toEqual(atPill);
  });
});
