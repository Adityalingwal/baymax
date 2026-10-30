import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { systemPreferences } from "electron";
import { UiohookKey } from "uiohook-napi";
import type { NotchSizes } from "./panel-geometry";

export const isMac = process.platform === "darwin";

// Shown in the panel's field placeholder and the hotkey log.
export const holdKeyLabel = isMac ? "⌥" : "Ctrl+Win";

// Windows uses a combo because single keys conflict with the OS: Alt opens the menu bar, Win opens Start.
export const holdKeys: readonly number[] = isMac
  ? [UiohookKey.Alt]
  : [UiohookKey.Ctrl, UiohookKey.Meta];

// A panel window shows over full-screen apps without taking focus; other platforms get a normal window.
export const panelWindowType: string | undefined = isMac ? "panel" : undefined;

type ProcessCall = (file: string, args: readonly string[]) => Promise<string>;

type ScreenReading = {
  id: number;
  screenWidth: number;
  leftWidth: number;
  rightWidth: number;
  top: number;
};

// Electron does not report the notch; NSScreenNumber is what Chromium uses as the display's id.
const readScreensScript = `
ObjC.import("AppKit");
const screens = $.NSScreen.screens;
const readings = [];
for (let i = 0; i < screens.count; i += 1) {
  const screen = screens.objectAtIndex(i);
  readings.push({
    id: ObjC.unwrap(screen.deviceDescription.objectForKey($("NSScreenNumber"))),
    screenWidth: screen.frame.size.width,
    leftWidth: screen.auxiliaryTopLeftArea.size.width,
    rightWidth: screen.auxiliaryTopRightArea.size.width,
    top: screen.safeAreaInsets.top,
  });
}
JSON.stringify(readings);
`;

const execFileAsync = promisify(execFile);

async function runProcess(
  file: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { timeout: 5000 });
  return stdout;
}

function isScreenReading(value: unknown): value is ScreenReading {
  if (typeof value !== "object" || value === null) return false;
  const fields = ["id", "screenWidth", "leftWidth", "rightWidth", "top"];
  return fields.every(
    (field) =>
      field in value &&
      typeof (value as Record<string, unknown>)[field] === "number",
  );
}

function notchSizesFrom(output: string): NotchSizes {
  const readings: unknown = JSON.parse(output);
  const sizes = new Map<number, { width: number; height: number }>();
  if (!Array.isArray(readings)) return sizes;
  for (const reading of readings) {
    if (!isScreenReading(reading)) continue;
    const { id, screenWidth, leftWidth, rightWidth, top } = reading;
    if (leftWidth > 0 && rightWidth > 0 && top > 0) {
      sizes.set(id, {
        width: screenWidth - leftWidth - rightWidth,
        height: top,
      });
    }
  }
  return sizes;
}

// Calls back when the active Space changes; Spaces exist only on a Mac.
export function onSpaceChange(callback: () => void): () => void {
  if (!isMac) return () => undefined;
  const id = systemPreferences.subscribeWorkspaceNotification(
    "NSWorkspaceActiveSpaceDidChangeNotification",
    callback,
  );
  return () => systemPreferences.unsubscribeWorkspaceNotification(id);
}

// The real notch of every screen that has one, by display id; empty when the call fails or no screen has a notch.
export async function readNotchSizes(
  run: ProcessCall = isMac ? runProcess : async () => "[]",
): Promise<NotchSizes> {
  try {
    const args = ["-l", "JavaScript", "-e", readScreensScript];
    return notchSizesFrom(await run("osascript", args));
  } catch (error) {
    console.warn("[Window] Could not read the notch size:", error);
    return new Map();
  }
}
