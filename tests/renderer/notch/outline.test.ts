import { describe, expect, it } from "vitest";
import {
  notchSilhouette,
  notchZone,
  openBodyWidth,
  openSilhouette,
  silhouettePath,
} from "../../../src/renderer/notch/outline";
import type {
  OutlineGeometry,
  Silhouette,
} from "../../../src/renderer/notch/outline";

const notched: OutlineGeometry = {
  width: 640,
  height: 720,
  shape: { notched: true, notchWidth: 139, notchHeight: 25 },
  contentHeight: 300,
};
const plain: OutlineGeometry = {
  ...notched,
  shape: { ...notched.shape, notched: false },
};
// A pill-sized shape with ears, as later collapsed shapes will be.
const pill: Silhouette = { width: 360, height: 32, ear: 6, rx: 24, ry: 26 };

function commands(path: string): string {
  return path.replace(/[^A-Za-z]/g, "");
}

type Box = { left: number; right: number; top: number; bottom: number };

// Every end and control point of the path, so the box is the outline's extent.
function pathBox(path: string): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, command, args] of path.matchAll(/([MHVQCZ])([^MHVQCZ]*)/g)) {
    const numbers = args
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (command === "H") xs.push(...numbers);
    if (command === "V") ys.push(...numbers);
    if (command === "M" || command === "Q" || command === "C") {
      numbers.forEach((value, index) =>
        (index % 2 === 0 ? xs : ys).push(value),
      );
    }
  }
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

describe("silhouettePath", () => {
  it("uses the same path commands for every silhouette", () => {
    const shapes = [
      notchSilhouette(notched.shape),
      notchSilhouette(plain.shape),
      openSilhouette(notched),
      pill,
    ];
    const sequences = shapes.map((shape) =>
      commands(silhouettePath(640, shape)),
    );
    expect(new Set(sequences).size).toBe(1);
  });

  it.each<{ name: string; shape: Silhouette; box: Box }>([
    {
      name: "the notch on a notched screen spans exactly the notch",
      shape: notchSilhouette(notched.shape),
      box: { left: 250.5, right: 389.5, top: 0, bottom: 25 },
    },
    {
      name: "the open panel's ears reach the window edges",
      shape: openSilhouette(notched),
      box: { left: 0, right: 640, top: 0, bottom: 300 },
    },
    {
      name: "the open panel stops at the window height",
      shape: openSilhouette({ ...notched, contentHeight: 900 }),
      box: { left: 0, right: 640, top: 0, bottom: 720 },
    },
    {
      name: "the open panel is never shorter than its strip and corners",
      shape: openSilhouette({ ...notched, contentHeight: 0 }),
      box: { left: 0, right: 640, top: 0, bottom: 60 },
    },
    {
      name: "a pill's ears flare 6 points past its body",
      shape: pill,
      box: { left: 134, right: 506, top: 0, bottom: 32 },
    },
  ])("$name", ({ shape, box }) => {
    expect(pathBox(silhouettePath(640, shape))).toEqual(box);
  });
});

describe("silhouettePath segments", () => {
  it("draws the open panel segment by segment", () => {
    expect(silhouettePath(640, openSilhouette(notched))).toBe(
      "M0,0 H640 Q634,0 634,6 V272 C634,290.2 624.9,300 608,300 H32 C15.1,300 6,290.2 6,272 V6 Q6,0 0,0 Z",
    );
  });

  it("rounds the notch's bottom corners only without a notch", () => {
    const corner = "377,25";
    expect(silhouettePath(640, notchSilhouette(plain.shape))).toContain(corner);
    expect(silhouettePath(640, notchSilhouette(notched.shape))).not.toContain(
      corner,
    );
  });
});

describe("open panel", () => {
  it("has a body two ears narrower than the window", () => {
    expect(openBodyWidth(notched)).toBe(628);
    expect(openSilhouette(notched).width).toBe(628);
  });
});

describe("notchZone", () => {
  it("reaches 12 points past the notch left, right and below", () => {
    expect(notchZone(notched)).toEqual({
      kind: "rect",
      rect: { x: 238.5, y: 0, width: 163, height: 37 },
    });
  });
});
