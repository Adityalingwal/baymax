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
import type { Wiring, WiringDeps } from "./main/wiring";
import { synthesizeSpeech, transcribeClip } from "./providers/deepgram";
import { startFlux } from "./providers/flux";
import { openWebSocket } from "./providers/warm-socket";
import { ipcChannels } from "./shared/ipc";
import type { HoldState, MainToRenderer, StartupInfo } from "./shared/ipc";

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
    stopHoldKey();
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

function sendToWindow<C extends keyof MainToRenderer>(
  channel: C,
  payload: MainToRenderer[C],
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendHoldState(state: HoldState): void {
  holdState = state;
  sendToWindow(ipcChannels.holdState, state);
}

function setTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

function voiceLog(message: string): void {
  console.info("[Voice]", message);
}

function voiceDeps(deepgramKey: string): WiringDeps["voice"] {
  const deepgram = { key: deepgramKey, fetch };
  const flux = { key: deepgramKey, openSocket: openWebSocket, setTimer };
  return {
    sendRecording: (command) => sendToWindow(ipcChannels.recording, command),
    sendSpeech: (line) => sendToWindow(ipcChannels.speech, line),
    sendStop: (payload) => sendToWindow(ipcChannels.stopPlayback, payload),
    transcribe: (audio, mimeType) => transcribeClip(deepgram, audio, mimeType),
    startFlux: (listener) =>
      deepgramKey === ""
        ? null
        : startFlux({ ...flux, log: voiceLog }, listener),
    synthesize: (text, signal) => synthesizeSpeech(deepgram, text, signal),
    now: () => performance.now(),
    log: voiceLog,
    deepgramKeyPresent: deepgramKey !== "",
  };
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
    publish: (display) => sendToWindow(ipcChannels.displayState, display),
    openUrl: (url) => shell.openExternal(url),
    timers: { setTimer },
    log: (message) => console.info("[main]", message),
    newTaskId: () => randomUUID(),
    fail: (error) => restart(error, "state failure in a listener"),
    voice: voiceDeps(keys.deepgramKey),
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
  // A reload or a crashed page loses its recording and playback; the first load may fire before this listener.
  mainWindow.webContents.on("render-process-gone", () =>
    started.voice.rendererReset(),
  );
  mainWindow.webContents.on("did-start-loading", () =>
    started.voice.rendererReset(),
  );

  if (!isMac || accessibilityAtStartup) {
    startHoldKey((state, outcome) => {
      sendHoldState(state);
      started.voice.holdChanged(state, outcome);
    });
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
