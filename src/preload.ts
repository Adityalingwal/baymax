import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "./shared/ipc";
import type { BaymaxApi, MainToRenderer, RendererToMain } from "./shared/ipc";

function subscribe<C extends keyof MainToRenderer>(
  channel: C,
  callback: (payload: MainToRenderer[C]) => void,
): () => void {
  // Drop Electron's event object so the renderer never sees it.
  const listener = (
    _event: Electron.IpcRendererEvent,
    payload: MainToRenderer[C],
  ) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// Ask main to replay the current state after subscribing, in case it changed before the window loaded.
function subscribeWithReplay<C extends keyof MainToRenderer>(
  channel: C,
  replayChannel:
    | typeof ipcChannels.getDisplayState
    | typeof ipcChannels.getWindowShape
    | typeof ipcChannels.getVoicePhase,
  callback: (payload: MainToRenderer[C]) => void,
): () => void {
  const cleanup = subscribe(channel, callback);
  ipcRenderer.send(replayChannel);
  return cleanup;
}

function send<C extends keyof RendererToMain>(
  channel: C,
  payload: RendererToMain[C],
): void {
  ipcRenderer.send(channel, payload);
}

// Only the typed BaymaxApi crosses the bridge: no raw IPC, no shell or URL access.
const api: BaymaxApi = {
  getStartupInfo: () => ipcRenderer.invoke(ipcChannels.getStartupInfo),
  openAccessibilitySettings: () => {
    ipcRenderer.send(ipcChannels.openAccessibilitySettings);
  },
  onDisplayState: (callback) =>
    subscribeWithReplay(
      ipcChannels.displayState,
      ipcChannels.getDisplayState,
      callback,
    ),
  submitQuestion: (payload) => send(ipcChannels.submitQuestion, payload),
  cancelTask: (payload) => send(ipcChannels.cancelTask, payload),
  retryTask: (payload) => send(ipcChannels.retryTask, payload),
  openSource: (payload) => send(ipcChannels.openSource, payload),
  setMuted: (payload) => send(ipcChannels.setMuted, payload),
  onRecording: (callback) => subscribe(ipcChannels.recording, callback),
  sendMicAudio: (audio) => send(ipcChannels.micAudio, audio),
  onSpeech: (callback) => subscribe(ipcChannels.speech, callback),
  onSpeechChunk: (callback) => subscribe(ipcChannels.speechChunk, callback),
  onSpeechEnd: (callback) => subscribe(ipcChannels.speechEnd, callback),
  onStopPlayback: (callback) => subscribe(ipcChannels.stopPlayback, callback),
  reportPlaybackFinished: (payload) =>
    send(ipcChannels.playbackFinished, payload),
  onWindowShape: (callback) =>
    subscribeWithReplay(
      ipcChannels.windowShape,
      ipcChannels.getWindowShape,
      callback,
    ),
  setMouseCapture: (payload) => send(ipcChannels.setMouseCapture, payload),
  onPointerOutside: (callback) =>
    subscribe(ipcChannels.pointerOutside, callback),
  onVoicePhase: (callback) =>
    subscribeWithReplay(
      ipcChannels.voicePhase,
      ipcChannels.getVoicePhase,
      callback,
    ),
};

contextBridge.exposeInMainWorld("baymax", api);

declare global {
  interface Window {
    baymax: BaymaxApi;
  }
}
