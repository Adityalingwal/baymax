import { describe, expect, it } from "vitest";
import { dotButtonRect, hoverZone, shellOutline } from "./outline";
import type { OutlineGeometry } from "./outline";
import type { ShellMode } from "./shell";

const notched: OutlineGeometry = {
  width: 480,
  height: 720,
  shape: { notched: true, notchWidth: 139, notchHeight: 25 },
  contentHeight: 300,
};
const plain: OutlineGeometry = {
  ...notched,
  shape: { ...notched.shape, notched: false },
};

const modes: ShellMode[] = ["idle", "dot", "open"];

function commands(path: string): string {
  return path.replace(/[^A-Za-z]/g, "");
}

type Box = { left: number; right: number; top: number; bottom: number };

// Every end and control point of the path, so the box is the outline's extent.
function pathBox(path: string): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [, command, args] of path.matchAll(/([MHVQZ])([^MHVQZ]*)/g)) {
    const numbers = args
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (command === "H") xs.push(...numbers);
    if (command === "V") ys.push(...numbers);
    if (command === "M" || command === "Q") {
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

type BoxRow = {
  name: string;
  geometry: OutlineGeometry;
  mode: ShellMode;
  box: Box;
};

const boxRows: BoxRow[] = [
  {
    name: "idle on a notched screen spans exactly the notch",
    geometry: notched,
    mode: "idle",
    box: { left: 170.5, right: 309.5, top: 0, bottom: 25 },
  },
  {
    name: "dot adds a 32-point wing on each side of the notch",
    geometry: notched,
    mode: "dot",
    box: { left: 138.5, right: 341.5, top: 0, bottom: 25 },
  },
  {
    name: "open spans the window width down to the content height",
    geometry: notched,
    mode: "open",
    box: { left: 0, right: 480, top: 0, bottom: 300 },
  },
  {
    name: "open stops at the window height when the content is taller",
    geometry: { ...notched, contentHeight: 900 },
    mode: "open",
    box: { left: 0, right: 480, top: 0, bottom: 720 },
  },
];

describe("shellOutline", () => {
  it.each([notched, plain])(
    "uses the same path commands in every mode (notched: $shape.notched)",
    (geometry) => {
      const sequences = modes.map((mode) =>
        commands(shellOutline(geometry, mode)),
      );
      expect(new Set(sequences).size).toBe(1);
    },
  );

  it.each(boxRows)("$name", ({ geometry, mode, box }) => {
    expect(pathBox(shellOutline(geometry, mode))).toEqual(box);
  });

  it.each<{ mode: ShellMode; path: string }>([
    {
      mode: "idle",
      path: "M170.5,0 H309.5 V0 Q309.5,0 309.5,0 H309.5 Q309.5,0 309.5,0 V25 Q309.5,25 309.5,25 H170.5 Q170.5,25 170.5,25 V0 Q170.5,0 170.5,0 H170.5 Q170.5,0 170.5,0 Z",
    },
    {
      mode: "open",
      path: "M170.5,0 H309.5 V17 Q309.5,25 317.5,25 H458 Q480,25 480,47 V278 Q480,300 458,300 H22 Q0,300 0,278 V47 Q0,25 22,25 H162.5 Q170.5,25 170.5,17 Z",
    },
  ])("draws the $mode outline segment by segment", ({ mode, path }) => {
    expect(shellOutline(notched, mode)).toBe(path);
  });

  it("keeps the whole reopen dot button inside the rounded right wing", () => {
    const rect = dotButtonRect(notched);
    const radius = 12.5;
    const corner = { x: 341.5 - radius, y: 25 - radius };
    expect(rect.x).toBeGreaterThanOrEqual(309.5);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    const far = { x: rect.x + rect.width, y: rect.y + rect.height };
    expect(Math.hypot(far.x - corner.x, far.y - corner.y)).toBeLessThanOrEqual(
      radius,
    );
  });

  it("rounds the bottom corners of the idle pill only without a notch", () => {
    const corner = "Q309.5,25 297,25";
    expect(shellOutline(plain, "idle")).toContain(corner);
    expect(shellOutline(notched, "idle")).not.toContain(corner);
  });
});

type ZoneRow = { name: string; mode: ShellMode; rect: object };

const zoneRows: ZoneRow[] = [
  {
    name: "idle reaches 12 points past the notch left, right and below",
    mode: "idle",
    rect: { x: 158.5, y: 0, width: 163, height: 37 },
  },
  {
    name: "dot reaches 12 points past the left wing and below, and stops at the notch before the reopen dot",
    mode: "dot",
    rect: { x: 126.5, y: 0, width: 183, height: 37 },
  },
];

describe("hoverZone", () => {
  it.each(zoneRows)("$name", ({ mode, rect }) => {
    expect(hoverZone(notched, mode)).toEqual({ kind: "rect", rect });
  });

  it("is the outline itself when open", () => {
    expect(hoverZone(notched, "open")).toEqual({
      kind: "path",
      path: shellOutline(notched, "open"),
    });
  });
});
