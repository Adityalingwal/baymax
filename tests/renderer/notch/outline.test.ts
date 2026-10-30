import { describe, expect, it } from "vitest";
import {
  notchSilhouette,
  notchZone,
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
  width: 688,
  height: 560,
  shape: { notched: true, notchWidth: 139, notchHeight: 25 },
  contentWidth: 470,
  contentHeight: 300,
  fullReport: false,
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
      name: "the open panel's ears flare 24 points past its body",
      shape: openSilhouette(notched),
      box: { left: 61, right: 579, top: 0, bottom: 300 },
    },
    {
      name: "the pill's ears flare 14 points past its body",
      shape: pillShape,
      box: { left: 126, right: 514, top: 0, bottom: 32 },
    },
    {
      name: "the ring's ears flare 8 points past its body",
      shape: ring,
      box: { left: 217.5, right: 422.5, top: 0, bottom: 25 },
    },
  ])("$name", ({ shape, box }) => {
    expect(pathBox(silhouettePath(640, shape))).toEqual(box);
  });
});

type HeightRow = {
  name: string;
  shape: Silhouette;
  ear: number;
  ry: number;
  rx: number;
};

const heightRows: HeightRow[] = [
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
];

describe("silhouettePath segments", () => {
  it("draws the open panel segment by segment, its ears' control points 30% from the corner", () => {
    expect(silhouettePath(688, openSilhouette(notched))).toBe(
      "M85,0 H603 C586.2,0 579,16.8 579,24 V272 C579,290.2 569.9,300 553,300 H135 C118.1,300 109,290.2 109,272 V24 C109,16.8 101.8,0 85,0 Z",
    );
  });

  it.each(heightRows)("$name", ({ shape, ear, ry, rx }) => {
    const left = (640 - shape.width) / 2;
    const h = shape.height;
    const path = silhouettePath(640, shape);
    expect(path).toContain(`M${left - ear},0`);
    expect(path).toContain(`V${h - ry} C`);
    expect(path).toContain(`H${left + rx} C`);
  });

  it.each([
    { name: "a pill's half-height", shape: plain.shape, corner: "377,25" },
    { name: "8 points", shape: notched.shape, corner: "381.5,25" },
  ])("rounds the rest shape's bottom corners by $name", ({ shape, corner }) => {
    expect(silhouettePath(640, notchSilhouette(shape))).toContain(corner);
  });
});

type SizeRow = {
  name: string;
  change: Partial<OutlineGeometry>;
  width: number;
  height: number;
};

const sizeRows: SizeRow[] = [
  {
    name: "short content takes the minimum width",
    change: { contentWidth: 200 },
    width: 420,
    height: 300,
  },
  {
    name: "the width follows the longest line between the limits",
    change: {},
    width: 470,
    height: 300,
  },
  {
    name: "longer text stops at the maximum width",
    change: { contentWidth: 900 },
    width: 520,
    height: 300,
  },
  {
    name: "the height stops at its maximum",
    change: { contentHeight: 900 },
    width: 470,
    height: 420,
  },
  {
    name: "a full report is 640 wide and up to 560 tall",
    change: { fullReport: true, contentHeight: 900 },
    width: 640,
    height: 560,
  },
  {
    name: "a short report keeps its own height at the report's width",
    change: { fullReport: true },
    width: 640,
    height: 300,
  },
  {
    name: "on a short screen the height stops at the window",
    change: { height: 340, contentHeight: 900 },
    width: 470,
    height: 340,
  },
  {
    name: "on a short screen a full report also stops at the window",
    change: { height: 484, fullReport: true, contentHeight: 900 },
    width: 640,
    height: 484,
  },
  {
    name: "it is never shorter than its strip and corners",
    change: { contentHeight: 0 },
    width: 470,
    height: 60,
  },
];

describe("the open panel's size", () => {
  it.each(sizeRows)("$name", ({ change, width, height }) => {
    expect(openSilhouette({ ...notched, ...change })).toMatchObject({
      width,
      height,
    });
  });
});

describe("ringSilhouette", () => {
  it.each([
    { notchWidth: 139, width: 189 },
    { notchWidth: 185, width: 235 },
  ])("is $width wide on a $notchWidth notch", ({ notchWidth, width }) => {
    const shape = { notched: true, notchWidth, notchHeight: 25 };
    expect(ringSilhouette(shape).width).toBe(width);
  });
});

describe("notchZone", () => {
  it("is the notch itself, with no margin", () => {
    expect(notchZone(notched)).toEqual({
      kind: "rect",
      rect: { x: 274.5, y: 0, width: 139, height: 25 },
    });
  });
});
