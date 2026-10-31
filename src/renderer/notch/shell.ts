// When the panel opens and closes. Rules and timings: notch-design-locked.md, "Panel close and motion", with design-lock-timing.md's updates.
export const panelDelays = {
  dwellMs: 200,
  leaveMs: 300,
  draftMs: 3000,
} as const;

// dwell, leave and draftLeave hold the token of their running timer, so a timer that fires after its reason is gone does nothing.
export type PanelState = {
  open: boolean;
  closing: boolean; // closed, but the close motion still shows
  inNotch: boolean; // in the notch's hover sensor
  inOpenOutline: boolean; // in the open panel's full outline
  inVisible: boolean; // in the shape as drawn right now
  hovering: boolean; // in that shape after the pointer really moved: a shape that grew under a still pointer does not count
  draft: string; // the field's text
  mouseDown: boolean; // a button pressed inside the panel is still down
  viewClicked: boolean; // a click changed the view and the pointer has not moved since: a shorter view does not close the panel under it
  needsAccess: boolean; // the setup checklist or the missing-key line holds the panel open
  waitForExit: boolean; // closed by Esc: no reopen until the pointer leaves the notch
  dwell: number | null;
  leave: number | null;
  draftLeave: number | null;
  tokens: number;
};

export type PanelEvent =
  | {
      kind: "pointer";
      inNotch: boolean;
      inOpenOutline: boolean;
      inVisible: boolean;
      moved: boolean; // from a mouse move, not a shape changing under a still pointer
    }
  | { kind: "pointer-gone" }
  | { kind: "dwell-elapsed"; token: number }
  | { kind: "leave-elapsed"; token: number }
  | { kind: "draft-leave-elapsed"; token: number }
  | { kind: "escape" }
  | { kind: "close-control" }
  | { kind: "setup-done" }
  | { kind: "draft"; text: string }
  | { kind: "mouse"; down: boolean }
  | { kind: "access"; needed: boolean }
  | { kind: "closed" }
  | { kind: "open-result" }
  | { kind: "view-clicked" };

export const initialPanel: PanelState = {
  open: false,
  closing: false,
  inNotch: false,
  inOpenOutline: false,
  inVisible: false,
  hovering: false,
  draft: "",
  mouseDown: false,
  viewClicked: false,
  needsAccess: false,
  waitForExit: false,
  dwell: null,
  leave: null,
  draftLeave: null,
  tokens: 0,
};

function close(state: PanelState): PanelState {
  if (!state.open || state.needsAccess) return state;
  return { ...state, open: false, closing: true };
}

// Closes in every state, even over the setup checklist, so nothing can trap the user; the text stays.
function closeAtOnce(state: PanelState, waitForExit: boolean): PanelState {
  return state.open
    ? { ...state, open: false, closing: true, waitForExit }
    : state;
}

function pointerMoved(
  state: PanelState,
  event: Extract<PanelEvent, { kind: "pointer" }>,
): PanelState {
  const { inNotch, inOpenOutline, inVisible } = event;
  const hovering = inVisible && (event.moved || state.hovering);
  const viewClicked = state.viewClicked && !event.moved;
  const moved = {
    ...state,
    inNotch,
    inOpenOutline,
    inVisible,
    hovering,
    viewClicked,
  };
  // Only a pointer coming onto the shrinking shape turns the motion around, not one the shrink left behind.
  const reentered = inVisible && !state.inVisible;
  if (!state.open && state.closing && reentered && !state.waitForExit) {
    return { ...moved, open: true, closing: false };
  }
  return moved;
}

function pointerGone(state: PanelState): PanelState {
  return {
    ...state,
    inNotch: false,
    inOpenOutline: false,
    inVisible: false,
    hovering: false,
    viewClicked: false,
  };
}

function applyEvent(state: PanelState, event: PanelEvent): PanelState {
  switch (event.kind) {
    case "pointer":
      return pointerMoved(state, event);
    case "pointer-gone":
      return pointerGone(state);
    case "dwell-elapsed":
      if (event.token !== state.dwell) return state;
      return { ...state, open: true, closing: false };
    case "leave-elapsed":
      return event.token === state.leave
        ? { ...close(state), leave: null }
        : state;
    case "draft-leave-elapsed":
      return event.token === state.draftLeave
        ? { ...close(state), draftLeave: null }
        : state;
    case "escape": {
      const closed = close(state);
      return closed === state ? state : { ...closed, waitForExit: true };
    }
    case "close-control":
      return closeAtOnce(state, true);
    // The first hold after setup: its pill takes over, and a pointer resting on the notch must not reopen the panel over it.
    case "setup-done":
      return closeAtOnce(state, state.waitForExit || state.inNotch);
    // Each change drops the running timer, so a key typed outside restarts the 3 s.
    case "draft":
      return event.text === state.draft
        ? state
        : { ...state, draft: event.text, draftLeave: null };
    case "mouse":
      return { ...state, mouseDown: event.down };
    case "access":
      return event.needed
        ? { ...state, needsAccess: true, open: true, closing: false }
        : { ...state, needsAccess: false };
    case "closed":
      return state.open ? state : { ...state, closing: false };
    // A click on the answer island's card: the one open that is not a hover.
    case "open-result":
      return { ...state, open: true, closing: false, waitForExit: false };
    case "view-clicked":
      return { ...state, viewClicked: state.open };
  }
}

// Derives what the facts imply: the end of the Esc wait, a reopen mid-close, and which timers run.
function settle(state: PanelState): PanelState {
  let next = state;
  if (next.waitForExit && !next.inNotch && !next.inVisible) {
    next = { ...next, waitForExit: false };
  }
  if (!next.open && next.viewClicked) next = { ...next, viewClicked: false };
  const inside = next.inNotch || next.inOpenOutline;
  const held = next.needsAccess || next.mouseDown;
  const wantDwell = !next.open && next.inNotch && !next.waitForExit;
  const away = next.open && !inside && !held && !next.viewClicked;
  let tokens = next.tokens;
  const timer = (want: boolean, running: number | null) => {
    if (!want) return null;
    if (running !== null) return running;
    tokens += 1;
    return tokens;
  };
  const dwell = timer(wantDwell, next.dwell);
  const leave = timer(away && next.draft === "", next.leave);
  const draftLeave = timer(away && next.draft !== "", next.draftLeave);
  return { ...next, dwell, leave, draftLeave, tokens };
}

function sameState(a: PanelState, b: PanelState): boolean {
  const keys = Object.keys(a) as (keyof PanelState)[];
  return keys.every((key) => a[key] === b[key]);
}

// Returns the same object when nothing changes, so React skips the render.
export function panelReducer(state: PanelState, event: PanelEvent): PanelState {
  const next = settle(applyEvent(state, event));
  return sameState(state, next) ? state : next;
}
