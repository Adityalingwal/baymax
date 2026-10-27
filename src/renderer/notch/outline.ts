import type { WindowShape } from "../../shared/ipc";
import type { ShellMode } from "./shell";

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

const wingWidth = 32;
const filletRadius = 8;
const bodyRadius = 22;
const hoverMargin = 12;
const dotButtonSize = 20;

type OutlineParts = {
  neckLeft: number;
  neckRight: number;
  bodyTop: number;
  left: number;
  right: number;
  bottom: number;
  join: number;
  shoulder: number;
  radius: number;
};

function neck(geometry: OutlineGeometry) {
  const { width, shape } = geometry;
  const neckLeft = (width - shape.notchWidth) / 2;
  return { neckLeft, neckRight: neckLeft + shape.notchWidth };
}

// Collapsed modes have no neck: the body starts at y = 0 and is the notch's height.
function outlineParts(
  geometry: OutlineGeometry,
  mode: ShellMode,
): OutlineParts {
  const { neckLeft, neckRight } = neck(geometry);
  const notchHeight = geometry.shape.notchHeight;
  if (mode === "open") {
    const contentBottom = Math.min(geometry.contentHeight, geometry.height);
    return {
      neckLeft,
      neckRight,
      bodyTop: notchHeight,
      left: 0,
      right: geometry.width,
      // Never shorter than its own corners, so the path is valid before the content is measured.
      bottom: Math.max(contentBottom, notchHeight + 2 * bodyRadius),
      join: filletRadius,
      shoulder: bodyRadius,
      radius: bodyRadius,
    };
  }
  const wing = mode === "dot" ? wingWidth : 0;
  const rounded = mode === "dot" || !geometry.shape.notched;
  return {
    neckLeft,
    neckRight,
    bodyTop: 0,
    left: neckLeft - wing,
    right: neckRight + wing,
    bottom: notchHeight,
    join: 0,
    shoulder: 0,
    radius: rounded ? notchHeight / 2 : 0,
  };
}

// The same commands in every mode, so the CSS clip-path transition can interpolate between them.
export function shellOutline(
  geometry: OutlineGeometry,
  mode: ShellMode,
): string {
  const parts = outlineParts(geometry, mode);
  const { neckLeft, neckRight, bodyTop: top, left, right } = parts;
  const { bottom, join, shoulder, radius } = parts;
  return [
    `M${neckLeft},0 H${neckRight} V${top - join}`,
    `Q${neckRight},${top} ${neckRight + join},${top}`,
    `H${right - shoulder} Q${right},${top} ${right},${top + shoulder}`,
    `V${bottom - radius} Q${right},${bottom} ${right - radius},${bottom}`,
    `H${left + radius} Q${left},${bottom} ${left},${bottom - radius}`,
    `V${top + shoulder} Q${left},${top} ${left + shoulder},${top}`,
    `H${neckLeft - join} Q${neckLeft},${top} ${neckLeft},${top - join} Z`,
  ].join(" ");
}

// Collapsed, the hover zone reaches past the notch, which has no pixels to point at; it never captures clicks.
// With the dot it stops at the notch, so the pointer can reach the reopen dot without opening the shell first.
export function hoverZone(geometry: OutlineGeometry, mode: ShellMode): HitZone {
  if (mode === "open") {
    return { kind: "path", path: shellOutline(geometry, mode) };
  }
  const { left, right, bottom, neckRight } = outlineParts(geometry, mode);
  const end = mode === "dot" ? neckRight : right + hoverMargin;
  const rect = {
    x: left - hoverMargin,
    y: 0,
    width: end - (left - hoverMargin),
    height: bottom + hoverMargin,
  };
  return { kind: "rect", rect };
}

// A square centred in the dot mode's right wing, half way down the notch.
export function dotButtonRect(geometry: OutlineGeometry): Rect {
  const { neckRight } = neck(geometry);
  return {
    x: neckRight + (wingWidth - dotButtonSize) / 2,
    y: (geometry.shape.notchHeight - dotButtonSize) / 2,
    width: dotButtonSize,
    height: dotButtonSize,
  };
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
