import { describe, expect, it } from "vitest";
import {
  easeOutCubic,
  motionEnd,
  sample,
  smootherstep,
} from "../../../src/renderer/notch/motion";
import {
  closedTiming,
  planClosed,
} from "../../../src/renderer/notch/closed-plans";
import {
  planPanel,
  planResize,
  restingFrame,
} from "../../../src/renderer/notch/plans";

const notch = { width: 139, height: 25, ear: 0, rx: 0, ry: 0 };
const pill = { width: 360, height: 32, ear: 6, rx: 24, ry: 26 };
const opened = { width: 628, height: 300, ear: 6, rx: 26, ry: 28 };
const atNotch = restingFrame(notch, "notch");
const atPill = restingFrame(pill, "pill");

const grow = (reduced = false) =>
  planClosed(atNotch, { view: "pill", shape: pill }, { reduced, now: 0 });
const shrink = (reduced = false) =>
  planClosed(atPill, { view: "notch", shape: notch }, { reduced, now: 0 });

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

describe("the report opening and folding in the island", () => {
  const plain = { width: 480, height: 90, ear: 24, rx: 26, ry: 28 };
  const open = { width: 640, height: 560, ear: 24, rx: 26, ry: 28 };
  const expand = planClosed(
    restingFrame(plain, "island"),
    { view: "report", shape: open },
    { reduced: false, now: 0 },
  );
  const fold = planClosed(
    restingFrame(open, "report"),
    { view: "island", shape: plain, folding: true },
    { reduced: false, now: 0 },
  );

  it("takes the locked 720 ms both ways, with no bounce", () => {
    expect(motionEnd(expand)).toBeCloseTo(720);
    expect(motionEnd(fold)).toBeCloseTo(720);
    expect(expand.tracks.height.ease).toBe(smootherstep);
  });

  it("widens first when opening, and narrows last when folding", () => {
    expect(sample(expand, 396).width).toBe(640);
    expect(sample(expand, 115).height).toBe(90);
    expect(sample(fold, 324).width).toBe(640);
    expect(sample(fold, 605).height).toBeCloseTo(90);
  });
});

describe("planClosed between the notch and the pill", () => {
  it("grows the pill out of the notch in 200 ms, the word fading in over the last 140 ms", () => {
    const motion = grow();
    expect(sample(motion, 100).width).toBeCloseTo(249.5);
    expect(sample(motion, 60).pill).toBe(0);
    expect(sample(motion, 130).pill).toBeCloseTo(0.5);
    expect(motionEnd(motion)).toBe(200);
    expect(sample(motion, 200)).toEqual(atPill);
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
    const reopened = planClosed(
      current,
      { view: "pill", shape: pill },
      { reduced: false, now: 300 },
    );
    expect(sample(reopened, 300).width).toBeCloseTo(current.width, 6);
    expect(sample(reopened, 301).width).toBeGreaterThan(current.width);
    expect(sample(reopened, 300 + closedTiming.pillGrowMs)).toEqual(atPill);
  });

  it.each([
    { name: "grow", motion: () => grow(true), end: atPill },
    { name: "close", motion: () => shrink(true), end: atNotch },
  ])("with reduced motion swaps at once: $name", ({ motion, end }) => {
    expect(sample(motion(), 0)).toEqual(end);
  });
});

describe("the pill's silent close", () => {
  it("takes 260 ms, the word gone by 140 ms", () => {
    const motion = planClosed(
      atPill,
      { view: "notch", shape: notch, close: "silent" },
      { reduced: false, now: 0 },
    );
    expect(sample(motion, 70).pill).toBeCloseTo(0.5);
    expect(sample(motion, 140).pill).toBe(0);
    expect(motionEnd(motion)).toBe(260);
    expect(sample(motion, 260)).toEqual(atNotch);
  });
});

describe("planPanel with the pill", () => {
  const panelKeys = { collapsed: pill, opened, view: "pill" as const };

  it("hides the pill's word as the panel opens over it", () => {
    const motion = planPanel(atPill, panelKeys, {
      open: true,
      reduced: false,
      now: 0,
    });
    expect(sample(motion, 80)).toMatchObject({ pill: 0, rim: 0 });
  });

  it("lands back on the pill with its word", () => {
    const from = restingFrame(opened, "open");
    const motion = planPanel(from, panelKeys, {
      open: false,
      reduced: false,
      now: 0,
    });
    expect(sample(motion, 150).pill).toBe(0);
    expect(sample(motion, motionEnd(motion))).toEqual(atPill);
  });
});

describe("planPanel's size and rest", () => {
  it("closes onto the hidden notch, drawn until its last frame", () => {
    const hidden = { ...notch, hidden: true };
    const keys = { collapsed: hidden, opened, view: "notch" as const };
    const from = restingFrame(opened, "open");
    const motion = planPanel(from, keys, {
      open: false,
      reduced: false,
      now: 0,
    });
    const end = motionEnd(motion);
    expect(sample(motion, end - 1).shade).toBe(1);
    expect(sample(motion, end)).toEqual(restingFrame(hidden, "notch"));
  });

  it("resizes an open panel over 260 ms, easing out from where it is", () => {
    const wider = { ...opened, width: 500, height: 340 };
    const keys = { collapsed: pill, opened: wider, view: "pill" as const };
    const motion = planResize(restingFrame(opened, "open"), keys, 0);
    expect(sample(motion, 0).width).toBe(opened.width);
    expect(sample(motion, 130).width).toBeCloseTo(
      opened.width + (wider.width - opened.width) * easeOutCubic(0.5),
    );
    expect(motionEnd(motion)).toBe(260);
    expect(sample(motion, 260)).toEqual(restingFrame(wider, "open"));
  });
});
