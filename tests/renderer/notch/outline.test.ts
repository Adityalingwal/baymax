import { describe, expect, it } from "vitest";
import {
  notchSilhouette,
  notchZone,
  openBodyWidth,
  openSilhouette,
  pillShape,
  ringSilhouette,
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
const ring = ringSilhouette(notched.shape);

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
      pillShape,
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
      name: "the pill's ears flare 14 points past its body",
      shape: pillShape,
      box: { left: 126, right: 514, top: 0, bottom: 32 },
    },
    {
      name: "the ring's ears flare 8 points past its body",
      shape: ring,
      box: { left: 224.5, right: 415.5, top: 0, bottom: 25 },
    },
  ])("$name", ({ shape, box }) => {
    expect(pathBox(silhouettePath(640, shape))).toEqual(box);
  });
});

describe("silhouettePath segments", () => {
  it("draws the open panel segment by segment, its ears' control points 30% from the corner", () => {
    expect(silhouettePath(640, openSilhouette(notched))).toBe(
      "M0,0 H640 C623.2,0 616,16.8 616,24 V272 C616,290.2 606.9,300 590,300 H50 C33.1,300 24,290.2 24,272 V24 C24,16.8 16.8,0 0,0 Z",
    );
  });

  it.each<{
    name: string;
    shape: Silhouette;
    ear: number;
    ry: number;
    rx: number;
  }>([
    {
      name: "the pill's ear and corner fill its height exactly",
      shape: pillShape,
      ear: 14,
      ry: 18,
      rx: 16.6,
    },
    {
      name: "the ring keeps its corner",
      shape: ring,
      ear: 8,
      ry: 10,
      rx: 10,
    },
    {
      name: "a height smaller than ear plus corner shrinks the corner, with rx scaled",
      shape: { width: 360, height: 30, ear: 14, rx: 16.6, ry: 18 },
      ear: 14,
      ry: 16,
      rx: 14.756,
    },
    {
      name: "a height smaller than the ear keeps the outline from folding",
      shape: { width: 360, height: 10, ear: 14, rx: 16.6, ry: 18 },
      ear: 6,
      ry: 4,
      rx: 3.689,
    },
  ])("$name", ({ shape, ear, ry, rx }) => {
    const left = (640 - shape.width) / 2;
    const h = shape.height;
    const path = silhouettePath(640, shape);
    expect(path).toContain(`M${left - ear},0`);
    expect(path).toContain(`V${h - ry} C`);
    expect(path).toContain(`H${left + rx} C`);
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
    expect(openBodyWidth(notched)).toBe(592);
    expect(openSilhouette(notched).width).toBe(592);
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
