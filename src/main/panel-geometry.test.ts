import { describe, expect, it } from "vitest";
import { panelBounds, pickDisplay, windowShape } from "./panel-geometry";

type FakeDisplay = { id: number; internal: boolean };

describe("pickDisplay", () => {
  const external: FakeDisplay = { id: 1, internal: false };
  const builtIn: FakeDisplay = { id: 2, internal: true };
  const other: FakeDisplay = { id: 3, internal: false };

  it.each([
    {
      name: "the built-in display wins over the primary one",
      displays: [external, builtIn],
      primary: external,
      expected: builtIn,
    },
    {
      name: "without a built-in display, the primary one is used",
      displays: [external, other],
      primary: other,
      expected: other,
    },
  ])("$name", ({ displays, primary, expected }) => {
    expect(pickDisplay(displays, primary)).toBe(expected);
  });
});

describe("panelBounds", () => {
  it.each([
    {
      name: "centred at the top of a display at the origin",
      bounds: { x: 0, y: 0, width: 1280, height: 828 },
      expected: { x: 320, y: 0, width: 640, height: 720 },
    },
    {
      name: "centred at the top of a display with a non-zero origin",
      bounds: { x: -1920, y: -300, width: 1920, height: 1080 },
      expected: { x: -1280, y: -300, width: 640, height: 720 },
    },
    {
      name: "as tall as a display shorter than 720",
      bounds: { x: 0, y: 0, width: 1024, height: 600 },
      expected: { x: 192, y: 0, width: 640, height: 600 },
    },
  ])("$name", ({ bounds, expected }) => {
    expect(panelBounds({ bounds })).toEqual(expected);
  });
});

describe("windowShape", () => {
  it.each([
    {
      name: "the measured notch on a 1280-point display",
      width: 1280,
      notched: true,
      expected: { notched: true, notchWidth: 139, notchHeight: 25 },
    },
    {
      name: "the notch scaled to a 1710-point display",
      width: 1710,
      notched: true,
      expected: { notched: true, notchWidth: 186, notchHeight: 33 },
    },
    {
      name: "a display without a notch keeps the size and is not notched",
      width: 1280,
      notched: false,
      expected: { notched: false, notchWidth: 139, notchHeight: 25 },
    },
  ])("$name", ({ width, notched, expected }) => {
    const bounds = { x: 0, y: 0, width, height: 900 };
    expect(windowShape({ bounds }, notched)).toEqual(expected);
  });
});
