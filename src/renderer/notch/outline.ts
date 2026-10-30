import type { WindowShape } from "../../shared/ipc";

// Window size and content size in CSS pixels; the content height counts from y = 0, its top padding included.
export type OutlineGeometry = {
  width: number;
  height: number;
  shape: WindowShape;
  contentWidth: number;
  contentHeight: number;
  fullReport: boolean;
};

export type Rect = { x: number; y: number; width: number; height: number };

export type HitZone =
  { kind: "rect"; rect: Rect } | { kind: "path"; path: string };

// A black shape centred on the notch, top flush: body width and height, the concave ears that flare out at the top, and the bottom corners.
export type Silhouette = {
  width: number;
  height: number;
  ear: number;
  rx: number;
  ry: number;
  hidden?: boolean; // resting on it draws nothing
};

// Sizes from the locked design: design-lock-shape.md, "Ears".
export const panelShape = { ear: 24, rx: 26, ry: 28, strip: 32 } as const;
export const pillShape: Silhouette = {
  width: 360,
  height: 32,
  ear: 14,
  rx: 16.6,
  ry: 18,
};
const ringWing = 18;
// The curves' control points, as in the selected ears preview.
const earPull = 0.3;
const cornerPull = 0.35;
// Stops the ear passing the shape's bottom on a frame shorter than its ear.
const earClearance = 4;

export function ringSilhouette(shape: WindowShape): Silhouette {
  return {
    width: shape.notchWidth + 2 * ringWing,
    height: shape.notchHeight,
    ear: 8,
    rx: 10,
    ry: 10,
  };
}

// The panel fits its content between these: design-lock-shape.md, "Panel size". The window fits the widest with its ears.
export const panelLimits = {
  minWidth: 420,
  maxWidth: 520,
  reportWidth: 640,
  maxHeight: 420,
  reportHeight: 560,
} as const;

// The window's height is already capped for a short screen, so the panel never runs past it.
export function panelBox(windowHeight: number, fullReport: boolean) {
  const { minWidth, maxWidth, reportWidth, maxHeight, reportHeight } =
    panelLimits;
  return {
    minWidth: fullReport ? reportWidth : minWidth,
    maxWidth: fullReport ? reportWidth : maxWidth,
    maxHeight: Math.min(fullReport ? reportHeight : maxHeight, windowHeight),
  };
}

// macOS reports no notch radius; about 9 pt was estimated, so a shape closing onto this one never peeks past the real corners.
const notchCorner = 8;

// On a notched screen nothing is drawn at rest: this is only where a shape starts and ends, behind the hardware notch. Without a notch, a small pill.
export function notchSilhouette(shape: WindowShape): Silhouette {
  const radius = shape.notched ? notchCorner : shape.notchHeight / 2;
  return {
    width: shape.notchWidth,
    height: shape.notchHeight,
    ear: 0,
    rx: radius,
    ry: radius,
    ...(shape.notched ? { hidden: true } : {}),
  };
}

// Never shorter than its strip and corners, so the path is valid before the content is measured.
export function openSilhouette(geometry: OutlineGeometry): Silhouette {
  const { ear, rx, ry, strip } = panelShape;
  const box = panelBox(geometry.height, geometry.fullReport);
  const content = Math.min(geometry.contentHeight, box.maxHeight);
  return {
    width: Math.min(
      box.maxWidth,
      Math.max(box.minWidth, geometry.contentWidth),
    ),
    height: Math.max(content, strip + ry),
    ear,
    rx,
    ry,
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// The same commands for every silhouette, so a shape can move between any two of them.
export function silhouettePath(windowWidth: number, s: Silhouette): string {
  const left = round((windowWidth - s.width) / 2);
  const right = round(left + s.width);
  const n = (value: number) => round(value);
  const h = s.height;
  const ear = Math.min(s.ear, Math.max(0, h - earClearance));
  // The ear and the corner share the height; without this the outline folds back on itself and shows a cut line.
  const ry = Math.min(s.ry, h - ear);
  const rx = s.ry === 0 ? 0 : (s.rx * ry) / s.ry;
  const pull = earPull * ear;
  return [
    `M${n(left - ear)},0 H${n(right + ear)} C${n(right + pull)},0 ${right},${n(ear - pull)} ${right},${n(ear)}`,
    `V${n(h - ry)} C${right},${n(h - cornerPull * ry)} ${n(right - cornerPull * rx)},${n(h)} ${n(right - rx)},${n(h)}`,
    `H${n(left + rx)} C${n(left + cornerPull * rx)},${n(h)} ${left},${n(h - cornerPull * ry)} ${left},${n(h - ry)}`,
    `V${n(ear)} C${left},${n(ear - pull)} ${n(left - pull)},0 ${n(left - ear)},0 Z`,
  ].join(" ");
}

const rimInset = 1;
const rimAlong = 56;

// One of the pill's corner lines, its 2 pt stroke just inside the edge: from where the ear ends, round the corner, then along the bottom.
export function rimLine(side: "left" | "right", boxWidth: number) {
  const { height, rx, ry } = pillShape;
  const x = side === "left" ? rimInset : boxWidth - rimInset;
  const along = (by: number) => round(side === "left" ? x + by : x - by);
  const bottom = height - rimInset;
  const cornerX = rx - rimInset;
  const cornerY = ry - rimInset;
  const end = along(cornerX + rimAlong);
  return {
    x,
    end,
    path: [
      `M${x},${round(bottom - cornerY)}`,
      `C${x},${round(bottom - cornerPull * cornerY)} ${along(cornerPull * cornerX)},${bottom} ${along(cornerX)},${bottom}`,
      `H${end}`,
    ].join(" "),
  };
}

// The hover sensor that opens the panel: only the notch itself, so the wings beside it and the menu bar never open it.
export function notchZone(geometry: OutlineGeometry): HitZone {
  const { shape, width } = geometry;
  const rect = {
    x: (width - shape.notchWidth) / 2,
    y: 0,
    width: shape.notchWidth,
    height: shape.notchHeight,
  };
  return { kind: "rect", rect };
}

export type HitTest = (zone: HitZone, x: number, y: number) => boolean;

export function createHitTest(): HitTest {
  const context = document.createElement("canvas").getContext("2d");
  return (zone, x, y) => {
    if (zone.kind === "rect") {
      const { rect } = zone;
      return (
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      );
    }
    return context?.isPointInPath(new Path2D(zone.path), x, y) ?? false;
  };
}
