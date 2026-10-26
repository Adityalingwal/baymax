import { app, ipcMain, shell, systemPreferences } from "electron";
import type { BrowserWindow } from "electron";
import { startHoldKey, stopHoldKey } from "./main/hotkey";
import { holdKeyLabel, isMac } from "./main/platform";
import { createMainWindow } from "./main/window";
import { ipcChannels } from "./shared/ipc";
import type { HoldState, StartupInfo } from "./shared/ipc";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the package ships no type declarations, so it is loaded untyped.
if (require("electron-squirrel-startup")) {
  app.quit();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// `npm start` runs the generic Electron binary; show our name in the menu bar and Dock.
if (isMac) {
  app.setName("Baymax");
}

let mainWindow: BrowserWindow | null = null;
// Current state is kept here so a renderer that mounts (or reloads) mid-hold can ask for it.
let holdState: HoldState = "idle";

function getAccessibilityStatus(): boolean | null {
  if (!isMac) return null;
  return systemPreferences.isTrustedAccessibilityClient(false);
}

function sendHoldState(state: HoldState): void {
  holdState = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ipcChannels.holdState, state);
  }
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(() => {
      // One snapshot for both the hook guard and the renderer hint, so they never disagree.
      const accessibilityAtStartup = getAccessibilityStatus();

      ipcMain.handle(ipcChannels.getStartupInfo, (): StartupInfo => ({
        accessibility: accessibilityAtStartup,
        holdKeyLabel,
      }));

      ipcMain.on(ipcChannels.getHoldState, (event) => {
        event.sender.send(ipcChannels.holdState, holdState);
      });

      // Only fired by the explicit button in the window.
      ipcMain.on(ipcChannels.openAccessibilitySettings, () => {
        if (!isMac) return;
        systemPreferences.isTrustedAccessibilityClient(true);
        shell
          .openExternal(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
          )
          .catch((error: unknown) => {
            console.error("[Accessibility] Failed to open settings:", error);
          });
      });

      mainWindow = createMainWindow();
      mainWindow.on("closed", () => {
        mainWindow = null;
      });

      if (!isMac || accessibilityAtStartup) {
        startHoldKey((state) => sendHoldState(state));
      } else {
        console.log(
          "[Hotkey] Waiting for Accessibility permission; listener not started",
        );
      }
    })
    .catch((error: unknown) => {
      console.error("[App] Startup failed:", error);
    });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", () => {
    stopHoldKey();
  });
}
