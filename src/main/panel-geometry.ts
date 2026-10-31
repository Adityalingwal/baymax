import type { WindowShape } from "../shared/ipc";

type DisplayBounds = Pick<Electron.Display, "bounds">;

export type NotchSizes = ReadonlyMap<number, { width: number; height: number }>;

// Fits the widest shape, the answer island at 640 pt, with its 24 pt ears, and the tallest (560 pt); the window never resizes, only the black shape inside it moves.
const panelWindow = { width: 688, height: 560, screenGap: 16 } as const;

// The small pill at rest when no notch was measured, sized from one real notch (139 x 25 points on a 1280-point-wide display).
const restPill = { width: 139, height: 25, displayWidth: 1280 } as const;

export function pickDisplay<D extends Pick<Electron.Display, "internal">>(
  displays: readonly D[],
  primary: D,
): D {
  return displays.find((display) => display.internal) ?? primary;
}

export function panelBounds(
  display: Pick<Electron.Display, "bounds" | "workArea">,
): Electron.Rectangle {
  const { bounds, workArea } = display;
  const { width, height, screenGap } = panelWindow;
  return {
    x: bounds.x + Math.round((bounds.width - width) / 2),
    y: bounds.y,
    width,
    height: Math.min(height, workArea.height - screenGap),
  };
}

export function windowShape(
  display: DisplayBounds & Pick<Electron.Display, "id">,
  notches: NotchSizes,
): WindowShape {
  const notch = notches.get(display.id);
  if (notch !== undefined) {
    return {
      notched: true,
      notchWidth: notch.width,
      notchHeight: notch.height,
    };
  }
  const scale = display.bounds.width / restPill.displayWidth;
  return {
    notched: false,
    notchWidth: Math.round(restPill.width * scale),
    notchHeight: Math.round(restPill.height * scale),
  };
}
