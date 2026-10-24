import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "./shared/ipc";
import type { BaymaxApi, HoldState } from "./shared/ipc";

// Only these three functions cross the bridge: no raw IPC, no shell or URL access.
const api: BaymaxApi = {
  onHoldState: (callback) => {
    // Drop Electron's event object so the renderer never sees it.
    const listener = (_event: Electron.IpcRendererEvent, state: HoldState) =>
      callback(state);
    ipcRenderer.on(ipcChannels.holdState, listener);
    // Ask main to replay the current state, in case the key is already held.
    ipcRenderer.send(ipcChannels.getHoldState);
    return () => {
      ipcRenderer.removeListener(ipcChannels.holdState, listener);
    };
  },
  getStartupInfo: () => ipcRenderer.invoke(ipcChannels.getStartupInfo),
  openAccessibilitySettings: () => {
    ipcRenderer.send(ipcChannels.openAccessibilitySettings);
  },
};

contextBridge.exposeInMainWorld("baymax", api);

declare global {
  interface Window {
    baymax: BaymaxApi;
  }
}
