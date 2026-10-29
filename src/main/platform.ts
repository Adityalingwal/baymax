import { UiohookKey } from "uiohook-napi";

export const isMac = process.platform === "darwin";

// Shown in the panel's field hint ("⌥ hold to talk") and the hotkey log.
export const holdKeyLabel = isMac ? "⌥" : "Ctrl+Win";

// Windows uses a combo because single keys conflict with the OS: Alt opens the menu bar, Win opens Start.
export const holdKeys: readonly number[] = isMac
  ? [UiohookKey.Alt]
  : [UiohookKey.Ctrl, UiohookKey.Meta];

// A panel window shows over full-screen apps without taking focus; other platforms get a normal window.
export const panelWindowType: string | undefined = isMac ? "panel" : undefined;

// Best effort: every built-in Mac screen is treated as notched; there is no API to detect the notch.
export function hasNotch(display: Pick<Electron.Display, "internal">): boolean {
  return isMac && display.internal;
}
