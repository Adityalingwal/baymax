import { contextBridge, ipcRenderer } from "electron";

type HoldState = "idle" | "listening";

type Permissions = {
  accessibility: boolean | null;
  platform: NodeJS.Platform;
};

// Only these three methods cross the bridge: no raw IPC, no shell or URL access.
contextBridge.exposeInMainWorld("baymax", {
  onHoldState: (callback: (state: HoldState) => void): (() => void) => {
    // Drop Electron's event object so the renderer never sees it.
    const handler = (_event: Electron.IpcRendererEvent, state: HoldState) =>
      callback(state);
    ipcRenderer.on("hold-state", handler);
    // Ask main to replay the current state, in case the key is already held.
    ipcRenderer.send("get-hold-state");
    return () => {
      ipcRenderer.removeListener("hold-state", handler);
    };
  },
  getPermissions: (): Promise<Permissions> =>
    ipcRenderer.invoke("get-permissions"),
  openAccessibilitySettings: (): void => {
    ipcRenderer.send("open-accessibility-settings");
  },
});

declare global {
  interface Window {
    baymax: {
      onHoldState: (callback: (state: HoldState) => void) => () => void;
      getPermissions: () => Promise<Permissions>;
      openAccessibilitySettings: () => void;
    };
  }
}
