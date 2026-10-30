import { describe, expect, it, vi } from "vitest";
import {
  panelBounds,
  pickDisplay,
  windowShape,
} from "../../src/main/panel-geometry";
import { readNotchSizes } from "../../src/main/platform";

vi.mock("uiohook-napi", () => ({
  UiohookKey: { Alt: 1, Ctrl: 2, Meta: 3 },
}));

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

const reading = (id: number, screenWidth: number, notch = { w: 0, h: 0 }) => ({
  id,
  screenWidth,
  leftWidth: notch.h === 0 ? 0 : (screenWidth - notch.w) / 2,
  rightWidth: notch.h === 0 ? 0 : (screenWidth - notch.w) / 2,
  top: notch.h,
});

describe("the notch reading", () => {
  const builtIn = {
    id: 1,
    internal: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
  };
  const externalMain = {
    id: 7,
    internal: false,
    bounds: { x: -1710, y: 0, width: 1710, height: 1107 },
  };
  const realNotch = { w: 185, h: 37 };
  const smallPill = { notched: false, notchWidth: 186, notchHeight: 33 };
  const measured = { notched: true, notchWidth: 185, notchHeight: 37 };

  it.each([
    {
      name: "a notched Mac uses its own notch, not a scaled estimate",
      call: async () => JSON.stringify([reading(1, 1512, realNotch)]),
      displays: [builtIn],
      expected: measured,
    },
    {
      name: "a Mac with no notch keeps the small pill at rest",
      call: async () => JSON.stringify([reading(7, 1710)]),
      displays: [externalMain],
      expected: smallPill,
    },
    {
      name: "a failed call keeps the small pill at rest",
      call: () => Promise.reject(new Error("osascript failed")),
      displays: [externalMain],
      expected: smallPill,
    },
    {
      name: "an external main screen listed first: the selected internal screen's notch is used",
      call: async () =>
        JSON.stringify([reading(7, 1710), reading(1, 1512, realNotch)]),
      displays: [externalMain, builtIn],
      expected: measured,
    },
  ])("$name", async ({ call, displays, expected }) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notches = await readNotchSizes(call);
    const display = pickDisplay(displays, externalMain);
    expect(windowShape(display, notches)).toEqual(expected);
  });
});
