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
    typeof ipcChannels.getHoldState | typeof ipcChannels.getDisplayState,
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
  onHoldState: (callback) =>
    subscribeWithReplay(
      ipcChannels.holdState,
      ipcChannels.getHoldState,
      callback,
    ),
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
  answerQuestion: (payload) => send(ipcChannels.answerQuestion, payload),
  cancelTask: (payload) => send(ipcChannels.cancelTask, payload),
  retryTask: (payload) => send(ipcChannels.retryTask, payload),
  closeCard: (payload) => send(ipcChannels.closeCard, payload),
  setCardFolded: (payload) => send(ipcChannels.setCardFolded, payload),
  openSource: (payload) => send(ipcChannels.openSource, payload),
  setMuted: (payload) => send(ipcChannels.setMuted, payload),
  onRecording: (callback) => subscribe(ipcChannels.recording, callback),
  sendClip: (clip) => send(ipcChannels.sendClip, clip),
  onSpeech: (callback) => subscribe(ipcChannels.speech, callback),
  onStopPlayback: (callback) => subscribe(ipcChannels.stopPlayback, callback),
  reportPlaybackFinished: (payload) =>
    send(ipcChannels.playbackFinished, payload),
};

contextBridge.exposeInMainWorld("baymax", api);

declare global {
  interface Window {
    baymax: BaymaxApi;
  }
}
