import { BrowserWindow, screen } from "electron";
import type { IpcMainEvent } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { WindowShape } from "../shared/ipc";
import { panelBounds, pickDisplay, windowShape } from "./panel-geometry";
import { hasNotch, panelWindowType } from "./platform";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

type Placement = { bounds: Electron.Rectangle; shape: WindowShape };

function currentPlacement(): Placement {
  const display = pickDisplay(
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
  );
  return {
    bounds: panelBounds(display),
    shape: windowShape(display, hasNotch(display)),
  };
}

function createPanel(bounds: Electron.Rectangle): BrowserWindow {
  return new BrowserWindow({
    ...bounds,
    title: "Baymax",
    type: panelWindowType,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    // The panel is never made active, so without this every first click would only activate it.
    acceptFirstMouse: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}

// Clicks pass through; mouse moves are still forwarded so the page can find its shape.
function releaseMouse(browserWindow: BrowserWindow): void {
  if (!browserWindow.isDestroyed()) {
    browserWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function isMouseCapture(payload: unknown): payload is { captured: boolean } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "captured" in payload &&
    typeof payload.captured === "boolean"
  );
}

// Scoped to this window's webContents, so src/index.ts needs no handler; no ipcMain listener may exist for these channels.
function connectWindowChannels(
  browserWindow: BrowserWindow,
  currentShape: () => WindowShape,
): () => void {
  const { ipc } = browserWindow.webContents;
  const replayShape = (event: IpcMainEvent) => {
    event.sender.send(ipcChannels.windowShape, currentShape());
  };
  const setMouseCapture = (_event: IpcMainEvent, payload: unknown) => {
    if (!isMouseCapture(payload) || browserWindow.isDestroyed()) return;
    if (payload.captured) browserWindow.setIgnoreMouseEvents(false);
    else releaseMouse(browserWindow);
  };
  ipc.on(ipcChannels.getWindowShape, replayShape);
  ipc.on(ipcChannels.setMouseCapture, setMouseCapture);
  return () => {
    ipc.removeListener(ipcChannels.getWindowShape, replayShape);
    ipc.removeListener(ipcChannels.setMouseCapture, setMouseCapture);
  };
}

function placePanel(browserWindow: BrowserWindow, placement: Placement): void {
  const requested = placement.bounds;
  browserWindow.setBounds(requested);
  const actual = browserWindow.getBounds();
  if (actual.y !== requested.y) {
    console.warn("[Window] Panel is not at the requested y:", {
      requested,
      actual,
    });
  }
}

function samePlacement(a: Placement, b: Placement): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Moves the panel to the chosen display and resends its shape; never shows or focuses it.
function followDisplays(
  browserWindow: BrowserWindow,
  first: Placement,
  setShape: (shape: WindowShape) => void,
): () => void {
  let last = first;
  // Work-area changes (Dock or menu bar showing) fire too; an unchanged placement must not collapse an open shell.
  const replace = () => {
    if (browserWindow.isDestroyed()) return;
    const placement = currentPlacement();
    if (samePlacement(placement, last)) return;
    last = placement;
    placePanel(browserWindow, placement);
    setShape(placement.shape);
    browserWindow.webContents.send(ipcChannels.windowShape, placement.shape);
  };
  screen.on("display-added", replace);
  screen.on("display-removed", replace);
  screen.on("display-metrics-changed", replace);
  return () => {
    screen.removeListener("display-added", replace);
    screen.removeListener("display-removed", replace);
    screen.removeListener("display-metrics-changed", replace);
  };
}

function guardPage(browserWindow: BrowserWindow): void {
  const contents = browserWindow.webContents;
  // The renderer only shows main's state; a source link opens through main's typed action, never in this window.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (details) => {
    if (details.url !== MAIN_WINDOW_WEBPACK_ENTRY) details.preventDefault();
  });
  // A page that reloads or crashes while it held the mouse must not leave a block that swallows clicks.
  contents.on("did-start-loading", () => releaseMouse(browserWindow));
  contents.on("render-process-gone", () => releaseMouse(browserWindow));
}

export function createMainWindow(): BrowserWindow {
  const placement = currentPlacement();
  let shape = placement.shape;
  const browserWindow = createPanel(placement.bounds);
  releaseMouse(browserWindow);
  browserWindow.setAlwaysOnTop(true, "screen-saver");
  browserWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  guardPage(browserWindow);
  const stopChannels = connectWindowChannels(browserWindow, () => shape);
  const stopDisplays = followDisplays(browserWindow, placement, (next) => {
    shape = next;
  });
  browserWindow.on("closed", () => {
    stopChannels();
    stopDisplays();
  });
  browserWindow.once("ready-to-show", () => browserWindow.showInactive());
  browserWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY).catch((error: unknown) => {
    console.error("[Window] Failed to load the page:", error);
  });
  return browserWindow;
}
