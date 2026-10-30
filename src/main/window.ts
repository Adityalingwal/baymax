import { BrowserWindow, screen } from "electron";
import type { IpcMainEvent } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { WindowShape } from "../shared/ipc";
import { panelBounds, pickDisplay, windowShape } from "./panel-geometry";
import type { NotchSizes } from "./panel-geometry";
import { panelWindowType, readNotchSizes } from "./platform";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

function chosenDisplay(): Electron.Display {
  return pickDisplay(screen.getAllDisplays(), screen.getPrimaryDisplay());
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
    hiddenInMissionControl: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}

const cursorWatchMs = 100;

type MouseHold = { capture: () => void; release: () => void };

// While the page holds the mouse, a pointer that leaves the window may send it no last move, and a mouse-leave can report a point inside; only main sees the real cursor.
function createMouseHold(browserWindow: BrowserWindow): MouseHold {
  let watch: ReturnType<typeof setInterval> | null = null;
  const stopWatch = () => {
    if (watch !== null) clearInterval(watch);
    watch = null;
  };
  const checkCursor = () => {
    if (browserWindow.isDestroyed()) {
      stopWatch();
      return;
    }
    const { x, y } = screen.getCursorScreenPoint();
    const area = browserWindow.getBounds();
    const inX = x >= area.x && x < area.x + area.width;
    const inY = y >= area.y && y < area.y + area.height;
    if (inX && inY) return;
    stopWatch();
    browserWindow.webContents.send(ipcChannels.pointerOutside, null);
  };
  return {
    capture: () => {
      if (browserWindow.isDestroyed()) return;
      browserWindow.setIgnoreMouseEvents(false);
      if (watch === null) watch = setInterval(checkCursor, cursorWatchMs);
    },
    // Clicks pass through; mouse moves are still forwarded so the page can find its shape.
    release: () => {
      stopWatch();
      if (browserWindow.isDestroyed()) return;
      browserWindow.setIgnoreMouseEvents(true, { forward: true });
    },
  };
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
  currentShape: () => WindowShape | null,
  mouse: MouseHold,
): () => void {
  const { ipc } = browserWindow.webContents;
  const replayShape = (event: IpcMainEvent) => {
    const shape = currentShape();
    if (shape !== null) event.sender.send(ipcChannels.windowShape, shape);
  };
  const setMouseCapture = (_event: IpcMainEvent, payload: unknown) => {
    if (!isMouseCapture(payload)) return;
    if (payload.captured) mouse.capture();
    else mouse.release();
  };
  ipc.on(ipcChannels.getWindowShape, replayShape);
  ipc.on(ipcChannels.setMouseCapture, setMouseCapture);
  return () => {
    ipc.removeListener(ipcChannels.getWindowShape, replayShape);
    ipc.removeListener(ipcChannels.setMouseCapture, setMouseCapture);
  };
}

function placePanel(
  browserWindow: BrowserWindow,
  requested: Electron.Rectangle,
): void {
  browserWindow.setBounds(requested);
  const actual = browserWindow.getBounds();
  if (actual.y !== requested.y) {
    console.warn("[Window] Panel is not at the requested y:", {
      requested,
      actual,
    });
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// The page draws nothing until the first reading arrives, so a notched Mac never flashes the small pill.
function trackShape(browserWindow: BrowserWindow) {
  let shape: WindowShape | null = null;
  let measured = "";
  let latestRead = 0;
  const apply = (read: number, notches: NotchSizes) => {
    if (read !== latestRead || browserWindow.isDestroyed()) return;
    const next = windowShape(chosenDisplay(), notches);
    // An unchanged shape must not collapse an open shell.
    if (sameJson(next, shape)) return;
    shape = next;
    browserWindow.webContents.send(ipcChannels.windowShape, next);
  };
  const refresh = () => {
    const displays = screen.getAllDisplays();
    const key = JSON.stringify(displays.map(({ id, bounds }) => [id, bounds]));
    if (key === measured) return;
    measured = key;
    latestRead += 1;
    const read = latestRead;
    readNotchSizes()
      .then((notches) => apply(read, notches))
      .catch((error: unknown) => {
        console.error("[Window] Failed to apply the notch size:", error);
      });
  };
  return { current: () => shape, refresh };
}

// Moves the panel to the chosen display and refreshes its shape; never shows or focuses it.
function followDisplays(
  browserWindow: BrowserWindow,
  first: Electron.Rectangle,
  refreshShape: () => void,
): () => void {
  let last = first;
  // Work-area changes (Dock or menu bar showing) fire too; unchanged bounds and displays do nothing.
  const replace = () => {
    if (browserWindow.isDestroyed()) return;
    const bounds = panelBounds(chosenDisplay());
    if (!sameJson(bounds, last)) {
      last = bounds;
      placePanel(browserWindow, bounds);
    }
    refreshShape();
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

function guardPage(browserWindow: BrowserWindow, mouse: MouseHold): void {
  const contents = browserWindow.webContents;
  // The renderer only shows main's state; a source link opens through main's typed action, never in this window.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (details) => {
    if (details.url !== MAIN_WINDOW_WEBPACK_ENTRY) details.preventDefault();
  });
  // A page that reloads or crashes while it held the mouse must not leave a block that swallows clicks.
  contents.on("did-start-loading", mouse.release);
  contents.on("render-process-gone", mouse.release);
}

export function createMainWindow(): BrowserWindow {
  const bounds = panelBounds(chosenDisplay());
  const browserWindow = createPanel(bounds);
  const mouse = createMouseHold(browserWindow);
  mouse.release();
  browserWindow.setAlwaysOnTop(true, "screen-saver");
  browserWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  guardPage(browserWindow, mouse);
  const shape = trackShape(browserWindow);
  const stopChannels = connectWindowChannels(
    browserWindow,
    shape.current,
    mouse,
  );
  const stopDisplays = followDisplays(browserWindow, bounds, shape.refresh);
  shape.refresh();
  browserWindow.on("closed", () => {
    mouse.release();
    stopChannels();
    stopDisplays();
  });
  browserWindow.once("ready-to-show", () => browserWindow.showInactive());
  browserWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY).catch((error: unknown) => {
    console.error("[Window] Failed to load the page:", error);
  });
  return browserWindow;
}
