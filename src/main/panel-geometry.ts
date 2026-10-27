import type { WindowShape } from "../shared/ipc";

type DisplayBounds = Pick<Electron.Display, "bounds">;

const panelSize = { width: 480, height: 720 } as const;

// Measured on the demo Mac (139 x 25 points on a 1280-point-wide display), not detected.
const measuredNotch = { width: 139, height: 25, displayWidth: 1280 } as const;

export function pickDisplay<D extends Pick<Electron.Display, "internal">>(
  displays: readonly D[],
  primary: D,
): D {
  return displays.find((display) => display.internal) ?? primary;
}

export function panelBounds(display: DisplayBounds): Electron.Rectangle {
  const { bounds } = display;
  return {
    x: bounds.x + Math.round((bounds.width - panelSize.width) / 2),
    y: bounds.y,
    width: panelSize.width,
    height: Math.min(panelSize.height, bounds.height),
  };
}

export function windowShape(
  display: DisplayBounds,
  notched: boolean,
): WindowShape {
  const scale = display.bounds.width / measuredNotch.displayWidth;
  return {
    notched,
    notchWidth: Math.round(measuredNotch.width * scale),
    notchHeight: Math.round(measuredNotch.height * scale),
  };
}
