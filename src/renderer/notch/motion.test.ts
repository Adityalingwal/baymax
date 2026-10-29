import { describe, expect, it } from "vitest";
import { cubicBezier, motionEnd, progressAt, sample } from "./motion";
import type { Frame } from "./motion";
import { panelTiming, planPanel, restingFrame } from "./plans";
import type { PanelKeys } from "./plans";

const keys: PanelKeys = {
  collapsed: { width: 139, height: 25, ear: 0, rx: 0, ry: 0 },
  opened: { width: 628, height: 300, ear: 6, rx: 26, ry: 28 },
  pill: false,
};
const closedFrame = restingFrame(keys.collapsed, false);
const openFrame = restingFrame(keys.opened, true);

const plan = (from: Frame, open: boolean, reduced = false) =>
  planPanel(from, keys, { open, reduced, now: 1000 });

describe("cubicBezier", () => {
  it.each([
    { name: "starts at 0", curve: [0.22, 1, 0.36, 1], at: 0, value: 0 },
    { name: "ends at 1", curve: [0.4, 0, 1, 1], at: 1, value: 1 },
    {
      name: "the straight curve is linear",
      curve: [0, 0, 1, 1],
      at: 0.3,
      value: 0.3,
    },
  ])("$name", ({ curve, at, value }) => {
    const [x1, y1, x2, y2] = curve;
    expect(cubicBezier(x1, y1, x2, y2)(at)).toBeCloseTo(value, 4);
  });

  it("eases the open fast and the close slow at the start", () => {
    expect(panelTiming.openEase(0.25)).toBeGreaterThan(0.5);
    expect(panelTiming.closeEase(0.25)).toBeLessThan(0.1);
  });

  it("is inverted by progressAt", () => {
    const value = panelTiming.openEase(0.4);
    expect(progressAt(panelTiming.openEase, value)).toBeCloseTo(0.4, 4);
  });
});

describe("planPanel", () => {
  it("opens: the shape grows over 360 ms, the content fades in from 90 to 270 ms", () => {
    const motion = plan(closedFrame, true);
    expect(sample(motion, 1000)).toEqual(closedFrame);
    expect(sample(motion, 1090).content).toBe(0);
    expect(sample(motion, 1180).content).toBeCloseTo(0.5);
    expect(sample(motion, 1270).content).toBe(1);
    expect(sample(motion, 1270).height).toBeLessThan(300);
    expect(motionEnd(motion)).toBe(1360);
    expect(sample(motion, 1360)).toEqual(openFrame);
  });

  it("closes: the content fades out in 80 ms, then the shape shrinks in 220 ms", () => {
    const motion = plan(openFrame, false);
    expect(sample(motion, 1040).content).toBeCloseTo(0.5);
    expect(sample(motion, 1080)).toMatchObject({ content: 0, height: 300 });
    expect(sample(motion, 1190).height).toBeGreaterThan(25);
    expect(motionEnd(motion)).toBe(1300);
    expect(sample(motion, 1300)).toEqual(closedFrame);
  });

  it.each([
    { name: "a close mid-grow", first: true, at: 1200 },
    { name: "an open mid-close", first: false, at: 1200 },
    { name: "an open during the content fade-out", first: false, at: 1040 },
  ])("turns around from where it is: $name", ({ first, at }) => {
    const start = first ? closedFrame : openFrame;
    const current = sample(plan(start, first), at);
    const reversed = planPanel(current, keys, {
      open: !first,
      reduced: false,
      now: at,
    });
    const next = sample(reversed, at);
    for (const channel of ["width", "height", "content"] as const) {
      expect(next[channel]).toBeCloseTo(current[channel], 6);
    }
    expect(motionEnd(reversed)).toBeLessThan(at + panelTiming.openMs);
  });
});

describe("planPanel as content and settings change", () => {
  it("keeps the content shown when the open panel grows with its content", () => {
    const taller = { ...keys, opened: { ...keys.opened, height: 400 } };
    const motion = planPanel(openFrame, taller, {
      open: true,
      reduced: false,
      now: 1000,
    });
    expect(sample(motion, 1100).content).toBe(1);
    expect(sample(motion, 1100).height).toBeGreaterThan(300);
  });

  it("with reduced motion fades the open panel in over 120 ms without a grow", () => {
    const motion = plan(closedFrame, true, true);
    expect(sample(motion, 1000)).toMatchObject({ height: 300, shade: 0 });
    expect(sample(motion, 1060).shade).toBeCloseTo(0.5);
    expect(motionEnd(motion)).toBe(1120);
  });

  it("with reduced motion fades the panel out over 100 ms, then shows the notch", () => {
    const motion = plan(openFrame, false, true);
    expect(sample(motion, 1050)).toMatchObject({ height: 300, shade: 0.5 });
    expect(motionEnd(motion)).toBe(1100);
    expect(sample(motion, 1100)).toEqual(closedFrame);
  });
});
