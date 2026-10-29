// When the panel opens and closes. Rules and timings: notch-design-locked.md, "Panel close and motion", with the demo's simple close rule.
export const panelDelays = { dwellMs: 150, leaveMs: 300 } as const;

// dwell and leave hold the token of their running timer, so a timer that fires after its reason is gone does nothing.
export type PanelState = {
  open: boolean;
  closing: boolean; // closed, but the close motion still shows
  inNotch: boolean; // in the notch's hover sensor
  inOpenOutline: boolean; // in the open panel's full outline
  inVisible: boolean; // in the shape as drawn right now
  draft: boolean; // the field holds text
  mouseDown: boolean; // a button pressed inside the panel is still down
  needsAccess: boolean; // the Accessibility hint holds the panel open
  waitForExit: boolean; // closed by Esc: no reopen until the pointer leaves the notch
  dwell: number | null;
  leave: number | null;
  tokens: number;
};

export type PanelEvent =
  | {
      kind: "pointer";
      inNotch: boolean;
      inOpenOutline: boolean;
      inVisible: boolean;
    }
  | { kind: "pointer-gone" }
  | { kind: "dwell-elapsed"; token: number }
  | { kind: "leave-elapsed"; token: number }
  | { kind: "escape" }
  | { kind: "draft"; draft: boolean }
  | { kind: "mouse"; down: boolean }
  | { kind: "access"; needed: boolean }
  | { kind: "closed" };

export const initialPanel: PanelState = {
  open: false,
  closing: false,
  inNotch: false,
  inOpenOutline: false,
  inVisible: false,
  draft: false,
  mouseDown: false,
  needsAccess: false,
  waitForExit: false,
  dwell: null,
  leave: null,
  tokens: 0,
};

function close(state: PanelState): PanelState {
  if (!state.open || state.needsAccess) return state;
  return { ...state, open: false, closing: true };
}

function applyEvent(state: PanelState, event: PanelEvent): PanelState {
  switch (event.kind) {
    case "pointer": {
      const { inNotch, inOpenOutline, inVisible } = event;
      return { ...state, inNotch, inOpenOutline, inVisible };
    }
    case "pointer-gone":
      return {
        ...state,
        inNotch: false,
        inOpenOutline: false,
        inVisible: false,
      };
    case "dwell-elapsed":
      if (event.token !== state.dwell) return state;
      return { ...state, open: true, closing: false };
    case "leave-elapsed":
      return event.token === state.leave ? close(state) : state;
    case "escape": {
      const closed = close(state);
      return closed === state ? state : { ...closed, waitForExit: true };
    }
    case "draft":
      return { ...state, draft: event.draft };
    case "mouse":
      return { ...state, mouseDown: event.down };
    case "access":
      return event.needed
        ? { ...state, needsAccess: true, open: true, closing: false }
        : { ...state, needsAccess: false };
    case "closed":
      return state.open ? state : { ...state, closing: false };
  }
}

// Derives what the facts imply: the end of the Esc wait, a reopen mid-close, and which timers run.
function settle(state: PanelState): PanelState {
  let next = state;
  if (next.waitForExit && !next.inNotch && !next.inVisible) {
    next = { ...next, waitForExit: false };
  }
  // The pointer came back onto the shrinking shape: the motion turns around.
  if (!next.open && next.closing && next.inVisible && !next.waitForExit) {
    next = { ...next, open: true, closing: false };
  }
  const inside = next.inNotch || next.inOpenOutline;
  const held = next.needsAccess || next.draft || next.mouseDown;
  const wantDwell = !next.open && next.inNotch && !next.waitForExit;
  const wantLeave = next.open && !inside && !held;
  let tokens = next.tokens;
  const timer = (want: boolean, running: number | null) => {
    if (!want) return null;
    if (running !== null) return running;
    tokens += 1;
    return tokens;
  };
  const dwell = timer(wantDwell, next.dwell);
  const leave = timer(wantLeave, next.leave);
  return { ...next, dwell, leave, tokens };
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
