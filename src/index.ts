import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, ipcMain, shell, systemPreferences } from "electron";
import type { BrowserWindow } from "electron";
import { startEngine } from "./engine";
import { loadEnvFile } from "./main/env-file";
import { startHoldKey, stopHoldKey } from "./main/hotkey";
import { loadKeys } from "./main/keys";
import { holdKeyLabel, isMac } from "./main/platform";
import { createRestart } from "./main/restart";
import { createMainWindow } from "./main/window";
import { wireMain } from "./main/wiring";
import type { Wiring } from "./main/wiring";
import { ipcChannels } from "./shared/ipc";
import type { HoldState, StartupInfo } from "./shared/ipc";

const startedAt = Date.now();
let mainWindow: BrowserWindow | null = null;
let wiring: Wiring | null = null;
let workStopped = false;
// Current state is kept here so a renderer that mounts (or reloads) mid-hold can ask for it.
let holdState: HoldState = "idle";

// Registered before anything else runs, so a failure during start-up is covered too.
const restart = createRestart({
  showNotice: () => wiring?.state.showNotice("restarting"),
  stopWork: () => {
    workStopped = true;
    wiring?.close();
  },
  relaunch: (args) => app.relaunch({ args }),
  exit: (code) => app.exit(code),
  setTimer: (ms, fire) => {
    setTimeout(fire, ms);
  },
  log: (message, error) => {
    if (error === undefined) console.error("[Restart]", message);
    else console.error("[Restart]", message, error);
  },
  now: () => Date.now(),
  startedAt,
  args: process.argv.slice(1),
});
process.on("uncaughtException", (error) =>
  restart(error, "uncaught exception"),
);
process.on("unhandledRejection", (reason) =>
  restart(reason, "unhandled rejection"),
);

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

// Keys are read and removed from process.env here, before any window opens.
async function startEngineAndWiring(): Promise<Wiring> {
  await loadEnvFile({
    path: path.join(app.getAppPath(), ".env"),
    readFile: (file) => readFile(file, "utf8"),
    env: process.env,
    log: (message) => console.info("[Env]", message),
  });
  const keys = loadKeys(process.env);
  if (keys.missing.length > 0) {
    console.info("[Keys] Missing:", keys.missing.join(", "));
  }
  return wireMain({
    port: startEngine(keys.engine),
    ipc: ipcMain,
    isOwnSender: (sender) => sender === mainWindow?.webContents,
    publish: (display) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(ipcChannels.displayState, display);
      }
    },
    // The line text holds the user's words, so the log carries only its kind.
    say: (line) => console.info("[main]", `say ${line.kind} ${line.taskId}`),
    silence: (taskId) => console.info("[main]", `silence ${taskId}`),
    openUrl: (url) => shell.openExternal(url),
    timers: {
      setTimer: (ms, fire) => {
        const timer = setTimeout(fire, ms);
        return () => clearTimeout(timer);
      },
    },
    log: (message) => console.info("[main]", message),
    newTaskId: () => randomUUID(),
    fail: (error) => restart(error, "state failure in a listener"),
  });
}

function registerHoldHandlers(accessibilityAtStartup: boolean | null): void {
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
}

async function startApp(): Promise<void> {
  const started = await startEngineAndWiring();
  // A failure during the env read has already stopped work, so nothing more starts before the relaunch.
  if (workStopped) {
    started.close();
    return;
  }
  wiring = started;
  // One snapshot for both the hook guard and the renderer hint, so they never disagree.
  const accessibilityAtStartup = getAccessibilityStatus();
  registerHoldHandlers(accessibilityAtStartup);

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
    .then(startApp)
    .catch((error: unknown) => restart(error, "start-up failure"));

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", () => {
    stopHoldKey();
    wiring?.close();
  });
}
