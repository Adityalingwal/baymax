import type { WindowShape } from "../../shared/ipc";

// Window size and content height in CSS pixels; the content height counts from y = 0, its top padding included.
export type OutlineGeometry = {
  width: number;
  height: number;
  shape: WindowShape;
  contentHeight: number;
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
};

// Sizes from the locked design: notch-design-locked.md, "Panel".
export const panelShape = { ear: 6, rx: 26, ry: 28, strip: 32 } as const;
const hoverMargin = 12;
// The corner curve's control points, as in the locked pill preview.
const cornerPull = 0.35;

// Ears count inside the window, so the open panel's top edge spans the whole window and its body is two ears narrower.
export function openBodyWidth(geometry: OutlineGeometry): number {
  return geometry.width - 2 * panelShape.ear;
}

// Square on a notched screen (the shape hides behind the hardware notch), a small pill without one.
export function notchSilhouette(shape: WindowShape): Silhouette {
  const radius = shape.notched ? 0 : shape.notchHeight / 2;
  return {
    width: shape.notchWidth,
    height: shape.notchHeight,
    ear: 0,
    rx: radius,
    ry: radius,
  };
}

// Never shorter than its strip and corners, so the path is valid before the content is measured.
export function openSilhouette(geometry: OutlineGeometry): Silhouette {
  const { ear, rx, ry, strip } = panelShape;
  const content = Math.min(geometry.contentHeight, geometry.height);
  return {
    width: openBodyWidth(geometry),
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
  const { ear, rx, ry, height: h } = s;
  return [
    `M${n(left - ear)},0 H${n(right + ear)} Q${right},0 ${right},${n(ear)}`,
    `V${n(h - ry)} C${right},${n(h - cornerPull * ry)} ${n(right - cornerPull * rx)},${n(h)} ${n(right - rx)},${n(h)}`,
    `H${n(left + rx)} C${n(left + cornerPull * rx)},${n(h)} ${left},${n(h - cornerPull * ry)} ${left},${n(h - ry)}`,
    `V${n(ear)} Q${left},0 ${n(left - ear)},0 Z`,
  ].join(" ");
}

// The hover sensor that opens the panel: the notch and a margin past it, since the notch has no pixels to point at.
export function notchZone(geometry: OutlineGeometry): HitZone {
  const { shape, width } = geometry;
  const left = (width - shape.notchWidth) / 2;
  const rect = {
    x: left - hoverMargin,
    y: 0,
    width: shape.notchWidth + 2 * hoverMargin,
    height: shape.notchHeight + hoverMargin,
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
