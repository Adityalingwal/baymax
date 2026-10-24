import { UiohookKey } from "uiohook-napi";

export const isMac = process.platform === "darwin";

export const holdKeyLabel = isMac ? "Option" : "Ctrl+Win";

// Windows uses a combo because single keys conflict with the OS: Alt opens the menu bar, Win opens Start.
export const holdKeys: readonly number[] = isMac
  ? [UiohookKey.Alt]
  : [UiohookKey.Ctrl, UiohookKey.Meta];
