import { BrowserWindow } from "electron";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export function createMainWindow(): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 360,
    height: 200,
    title: "Baymax",
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The renderer only shows main's state; a source link opens through main's typed action, never in this window.
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  browserWindow.webContents.on("will-navigate", (details) => {
    if (details.url !== MAIN_WINDOW_WEBPACK_ENTRY) details.preventDefault();
  });
  browserWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY).catch((error: unknown) => {
    console.error("[Window] Failed to load the page:", error);
  });
  return browserWindow;
}
