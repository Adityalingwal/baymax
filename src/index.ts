import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, ipcMain, shell, systemPreferences } from "electron";
import type { BrowserWindow } from "electron";
import { startEngine } from "./engine";
import { loadEnvFile } from "./main/env-file";
import { startHoldKey, stopHoldKey } from "./main/hotkey";
import { loadKeys } from "./main/keys";
import { holdKeyLabel, isMac, privacySettingsUrls } from "./main/platform";
import { createRestart } from "./main/restart";
import { startSetup } from "./main/setup";
import type { Setup } from "./main/setup";
import { createMainWindow } from "./main/window";
import { wireMain } from "./main/wiring";
import type { Wiring, WiringDeps } from "./main/wiring";
import { startAura } from "./providers/aura";
import { createTextStream, createWarmUp } from "./providers/anthropic";
import { synthesizeSpeech, transcribeClip } from "./providers/deepgram";
import { startFlux } from "./providers/flux";
import { openWebSocket } from "./providers/warm-socket";
import { ipcChannels } from "./shared/ipc";
import type { MainToRenderer, StartupInfo, VoicePhase } from "./shared/ipc";

const startedAt = Date.now();
let mainWindow: BrowserWindow | null = null;
let wiring: Wiring | null = null;
let setup: Setup | null = null;
let workStopped = false;
let voicePhase: VoicePhase = { phase: "idle" };
// Set once the talker has a key: a key press opens its connection before the question needs it.
let warmTalker = (): void => undefined;

// Registered before anything else runs, so a failure during start-up is covered too.
const restart = createRestart({
  showNotice: () => wiring?.state.showNotice("restarting"),
  stopWork: () => {
    workStopped = true;
    setup?.stop();
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

function sendVoicePhase(phase: VoicePhase): void {
  voicePhase = phase;
  sendToWindow(ipcChannels.voicePhase, phase);
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
  const socket = { key: deepgramKey, openSocket: openWebSocket, setTimer };
  return {
    sendRecording: (command) => sendToWindow(ipcChannels.recording, command),
    sendSpeech: (line) => sendToWindow(ipcChannels.speech, line),
    sendChunk: (chunk) => sendToWindow(ipcChannels.speechChunk, chunk),
    sendEnd: (end) => sendToWindow(ipcChannels.speechEnd, end),
    sendStop: (payload) => sendToWindow(ipcChannels.stopPlayback, payload),
    sendVoicePhase,
    transcribe: (audio, mimeType) => transcribeClip(deepgram, audio, mimeType),
    startFlux: (listener) =>
      deepgramKey === ""
        ? null
        : startFlux({ ...socket, log: voiceLog }, listener),
    startAura: (listener) =>
      deepgramKey === ""
        ? null
        : startAura({ ...socket, log: voiceLog }, listener),
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
  if (keys.engine.anthropicKey !== "") warmTalker = createWarmUp({});
  return wireMain({
    port: startEngine(keys.engine),
    talkerStream:
      keys.engine.anthropicKey === ""
        ? null
        : createTextStream({ apiKey: keys.engine.anthropicKey }),
    ipc: ipcMain,
    isOwnSender: (sender) => sender === mainWindow?.webContents,
    publish: (display) => sendToWindow(ipcChannels.displayState, display),
    openUrl: (url) => shell.openExternal(url),
    timers: { setTimer },
    now: () => new Date(),
    log: (message) => console.info("[main]", message),
    nextTaskId: () => randomUUID(),
    fail: (error) => restart(error, "state failure in a listener"),
    voice: voiceDeps(keys.deepgramKey),
  });
}

function openPrivacySettings(url: string): void {
  shell.openExternal(url).catch((error: unknown) => {
    console.error("[Setup] Failed to open settings:", error);
  });
}

// Only fired by the explicit buttons in the window.
function registerSetupHandlers(): void {
  ipcMain.on(ipcChannels.getSetupState, (event) => {
    if (setup !== null) {
      event.sender.send(ipcChannels.setupState, setup.current());
    }
  });
  ipcMain.on(ipcChannels.openAccessibilitySettings, () => {
    if (!isMac) return;
    // The prompting form is what adds Electron's entry to the list.
    systemPreferences.isTrustedAccessibilityClient(true);
    openPrivacySettings(privacySettingsUrls.accessibility);
  });
  ipcMain.on(ipcChannels.askMicrophone, () => {
    if (!isMac) return;
    systemPreferences
      .askForMediaAccess("microphone")
      .then(() => setup?.recheck())
      .catch((error: unknown) => {
        console.error("[Setup] Failed to ask for the microphone:", error);
      });
  });
  ipcMain.on(ipcChannels.openMicrophoneSettings, () => {
    if (isMac) openPrivacySettings(privacySettingsUrls.microphone);
  });
}

function registerHoldHandlers(): void {
  ipcMain.handle(ipcChannels.getStartupInfo, (): StartupInfo => ({
    accessibility: getAccessibilityStatus(),
    holdKeyLabel,
  }));

  ipcMain.on(ipcChannels.getVoicePhase, (event) => {
    event.sender.send(ipcChannels.voicePhase, voicePhase);
  });
}

function startSetupChecks(started: Wiring): Setup {
  return startSetup({
    isMac,
    isTrusted: () => systemPreferences.isTrustedAccessibilityClient(false),
    microphoneStatus: () =>
      systemPreferences.getMediaAccessStatus("microphone"),
    startHoldKey: () =>
      startHoldKey((state, outcome) => {
        if (state === "listening") warmTalker();
        started.voice.holdChanged(state, outcome);
      }),
    publish: (state) => sendToWindow(ipcChannels.setupState, state),
    setTimer,
    log: (message, error) => {
      if (error === undefined) console.log(message);
      else console.error(message, error);
    },
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
  registerHoldHandlers();
  registerSetupHandlers();

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

  setup = startSetupChecks(started);
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
    setup?.stop();
    stopHoldKey();
    wiring?.close();
  });
}
