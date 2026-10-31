import { describe, expect, it } from "vitest";
import {
  initialPanel,
  panelDelays,
  panelReducer,
} from "../../../src/renderer/notch/shell";
import type { PanelEvent, PanelState } from "../../../src/renderer/notch/shell";

type Step = PanelEvent | ((state: PanelState) => PanelEvent);

const pointer = (
  inNotch: boolean,
  inOpenOutline: boolean,
  inVisible: boolean,
  moved = true,
): PanelEvent => ({
  kind: "pointer",
  inNotch,
  inOpenOutline,
  inVisible,
  moved,
});

const onNotch = pointer(true, true, true);
const onPanel = pointer(false, true, true);
// Inside the open outline but where nothing is drawn yet (or any more).
const onUndrawn = pointer(false, true, false);
// Outside the shrunk open outline but still inside the old, still-animating shape.
const inOldShapeOnly = pointer(false, false, true);
const away = pointer(false, false, false);
const gone: PanelEvent = { kind: "pointer-gone" };
// The running timer fires.
const dwell: Step = (state) => ({
  kind: "dwell-elapsed",
  token: state.dwell ?? -1,
});
const leave: Step = (state) => ({
  kind: "leave-elapsed",
  token: state.leave ?? -1,
});
const draftLeave: Step = (state) => ({
  kind: "draft-leave-elapsed",
  token: state.draftLeave ?? -1,
});
const escape: PanelEvent = { kind: "escape" };
const closeControl: PanelEvent = { kind: "close-control" };
const setupDone: PanelEvent = { kind: "setup-done" };
const closed: PanelEvent = { kind: "closed" };
const draft = (text: string): PanelEvent => ({ kind: "draft", text });
const mouse = (down: boolean): PanelEvent => ({ kind: "mouse", down });
const access: PanelEvent = { kind: "access", needed: true };
const opened: Step[] = [onNotch, dwell];

function run(steps: Step[]): PanelState {
  return steps.reduce<PanelState>((state, step) => {
    const event = typeof step === "function" ? step(state) : step;
    return panelReducer(state, event);
  }, initialPanel);
}

type Expected = {
  open: boolean;
  closing?: boolean;
  dwelling?: boolean;
  leaving?: boolean;
  draftLeaving?: boolean; // the 3 s timer is running
  waitForExit?: boolean;
};

const rows: { name: string; steps: Step[]; expected: Expected }[] = [
  {
    name: "the close control closes at once with the pointer on the panel",
    steps: [...opened, onPanel, closeControl],
    expected: { open: false, closing: true, leaving: false },
  },
  {
    name: "the close control closes with text in the field",
    steps: [...opened, onPanel, draft("hello"), closeControl],
    expected: { open: false, closing: true, draftLeaving: false },
  },
  {
    name: "the close control closes over the setup checklist",
    steps: [access, closeControl],
    expected: { open: false, closing: true },
  },
  {
    name: "the close control closes while a timer runs, and its firing does nothing",
    steps: [
      ...opened,
      away,
      closeControl,
      closed,
      { kind: "leave-elapsed", token: 2 },
    ],
    expected: { open: false, closing: false, leaving: false },
  },
  {
    name: "resting 200 ms on the notch opens",
    steps: opened,
    expected: { open: true, dwelling: false, leaving: false },
  },
  {
    name: "leaving the notch before 200 ms cancels the dwell",
    steps: [onNotch, away, { kind: "dwell-elapsed", token: 1 }],
    expected: { open: false, dwelling: false },
  },
  {
    name: "the open outline alone never opens a closed panel",
    steps: [onUndrawn],
    expected: { open: false, dwelling: false },
  },
  {
    name: "the pointer out for 300 ms closes",
    steps: [...opened, away, leave],
    expected: { open: false, closing: true, leaving: false },
  },
  {
    name: "leaving the window starts the close",
    steps: [...opened, gone],
    expected: { open: true, leaving: true },
  },
  {
    name: "a pointer gone from the window with its last point on the panel closes in 300 ms",
    steps: [...opened, onPanel, gone, leave],
    expected: { open: false, closing: true },
  },
  {
    name: "the pointer leaving during the grow starts the close timer",
    steps: [...opened, onUndrawn, away],
    expected: { open: true, leaving: true },
  },
  {
    name: "the undrawn part of a growing panel counts as inside",
    steps: [...opened, onUndrawn],
    expected: { open: true, leaving: false },
  },
  {
    name: "coming back within 300 ms cancels the close",
    steps: [...opened, away, onPanel, { kind: "leave-elapsed", token: 2 }],
    expected: { open: true, leaving: false },
  },
  {
    name: "a stale close timer from an earlier exit is ignored",
    steps: [
      ...opened,
      away,
      onPanel,
      away,
      { kind: "leave-elapsed", token: 2 },
    ],
    expected: { open: true, leaving: true },
  },
  {
    name: "a draft holds off the 300 ms close",
    steps: [...opened, draft("hi"), away],
    expected: { open: true, leaving: false, draftLeaving: true },
  },
  {
    name: "with a draft and the pointer on the panel, nothing closes",
    steps: [...opened, draft("hi"), onPanel],
    expected: { open: true, leaving: false, draftLeaving: false },
  },
  {
    name: "with a draft and the pointer out for 3 s, it closes",
    steps: [...opened, draft("hi"), away, draftLeave],
    expected: { open: false, closing: true, draftLeaving: false },
  },
  {
    name: "the pointer back stops the 3 s, and a stale timer does nothing",
    steps: [
      ...opened,
      draft("hi"),
      away,
      onPanel,
      { kind: "draft-leave-elapsed", token: 2 },
    ],
    expected: { open: true, draftLeaving: false },
  },
  {
    name: "a held mouse button also holds off the 3 s",
    steps: [...opened, draft("hi"), mouse(true), away],
    expected: { open: true, draftLeaving: false },
  },
  {
    name: "clearing the draft while out starts the close",
    steps: [...opened, draft("hi"), away, draft(""), leave],
    expected: { open: false, closing: true },
  },
  {
    name: "a held mouse button blocks the hover-exit close",
    steps: [...opened, mouse(true), away],
    expected: { open: true, leaving: false },
  },
  {
    name: "releasing the button outside starts the close",
    steps: [...opened, mouse(true), away, mouse(false), leave],
    expected: { open: false, closing: true },
  },
  {
    name: "Esc closes even with a draft",
    steps: [...opened, draft("hi"), escape],
    expected: { open: false, closing: true },
  },
  {
    name: "Esc during the grow closes",
    steps: [...opened, onUndrawn, escape],
    expected: { open: false, closing: true },
  },
  {
    name: "after Esc a pointer still on the notch does not reopen",
    steps: [...opened, escape, closed, onNotch],
    expected: { open: false, dwelling: false },
  },
  {
    name: "after Esc the shrinking shape under the pointer does not reopen",
    steps: [...opened, onPanel, escape, onPanel],
    expected: { open: false, closing: true },
  },
  {
    name: "after Esc, leaving the notch and coming back reopens",
    steps: [...opened, escape, closed, away, onNotch, dwell],
    expected: { open: true },
  },
  {
    name: "the pointer back on the shrinking shape reopens at once",
    steps: [...opened, away, leave, onPanel],
    expected: { open: true, closing: false, dwelling: false },
  },
  {
    name: "a pointer the shrink leaves behind does not hold the close open",
    steps: [...opened, onPanel, inOldShapeOnly, leave, away],
    expected: { open: false, closing: true, leaving: false },
  },
  {
    name: "a click's shorter view holds a still pointer it leaves outside, and the close starts once it moves",
    steps: [
      ...opened,
      onPanel,
      { kind: "view-clicked" },
      pointer(false, false, false, false),
      leave,
      away,
    ],
    expected: { open: true, leaving: true },
  },
  {
    name: "after such a close the pointer coming back reopens, and the close can run again",
    steps: [
      ...opened,
      onPanel,
      inOldShapeOnly,
      leave,
      away,
      onPanel,
      away,
      leave,
    ],
    expected: { open: false, closing: true, leaving: false },
  },
  {
    name: "the close motion ending clears closing",
    steps: [...opened, away, leave, closed],
    expected: { open: false, closing: false },
  },
  {
    name: "a stale end of a close after a reopen is ignored",
    steps: [...opened, away, leave, onPanel, closed],
    expected: { open: true, closing: false },
  },
  {
    name: "the setup checklist opens the panel by itself",
    steps: [access],
    expected: { open: true },
  },
  {
    name: "the setup checklist holds through Esc and the pointer out",
    steps: [access, onPanel, escape, away],
    expected: { open: true, leaving: false },
  },
  {
    name: "the first hold after setup closes while needsAccess holds, with no wait for the pointer to leave",
    steps: [access, setupDone],
    expected: { open: false, closing: true, waitForExit: false },
  },
  {
    name: "a pointer resting on the notch at that hold does not reopen the panel over the pill",
    steps: [onNotch, access, setupDone],
    expected: { open: false, dwelling: false, waitForExit: true },
  },
  {
    name: "a click on the answer island opens the panel at once",
    steps: [onPanel, { kind: "open-result" }],
    expected: { open: true, dwelling: false, leaving: false },
  },
  {
    name: "a click on the island opens even after an Esc",
    steps: [...opened, escape, { kind: "open-result" }],
    expected: { open: true, closing: false },
  },
];

// Only the fields a row names.
function shown(state: PanelState, expected: Expected): Expected {
  return {
    open: state.open,
    ...(expected.closing === undefined ? {} : { closing: state.closing }),
    ...(expected.dwelling === undefined
      ? {}
      : { dwelling: state.dwell !== null }),
    ...(expected.leaving === undefined
      ? {}
      : { leaving: state.leave !== null }),
    ...(expected.draftLeaving === undefined
      ? {}
      : { draftLeaving: state.draftLeave !== null }),
    ...(expected.waitForExit === undefined
      ? {}
      : { waitForExit: state.waitForExit }),
  };
}

describe("a pointer hovering the shape", () => {
  // The shape grows or shrinks under a pointer that does not move.
  const grewUnder = pointer(false, false, true, false);
  const shrankAway = pointer(false, false, false, false);
  it.each<{ name: string; steps: Step[]; hovering: boolean }>([
    {
      name: "a shape growing under a still pointer: no",
      steps: [grewUnder],
      hovering: false,
    },
    {
      name: "the pointer moving onto it: yes",
      steps: [onPanel],
      hovering: true,
    },
    {
      name: "the pointer moving inside after it grew under: yes",
      steps: [grewUnder, onPanel],
      hovering: true,
    },
    {
      name: "a frame re-checked after it moved on: still yes",
      steps: [onPanel, grewUnder],
      hovering: true,
    },
    {
      name: "the shape shrinking away from it: no",
      steps: [onPanel, shrankAway],
      hovering: false,
    },
    {
      name: "the pointer gone from the window: no",
      steps: [onPanel, gone],
      hovering: false,
    },
  ])("$name", ({ steps, hovering }) => {
    expect(run(steps).hovering).toBe(hovering);
  });
});

describe("panelReducer", () => {
  it.each(rows)("$name", ({ steps, expected }) => {
    const state = run(steps);
    expect(shown(state, expected)).toEqual(expected);
  });

  it.each([
    { name: "an Esc close", steps: [...opened, draft("hi"), escape] },
    {
      name: "the 3 s close",
      steps: [...opened, draft("hi"), away, draftLeave],
    },
  ])("keeps the draft through $name", ({ steps }) => {
    expect(run(steps).draft).toBe("hi");
  });

  it("restarts the 3 s when an already non-empty draft is edited outside", () => {
    const before = run([...opened, draft("hi"), away]);
    const after = panelReducer(before, draft("hi!"));
    expect(after.draftLeave).not.toBeNull();
    expect(after.draftLeave).not.toBe(before.draftLeave);
    const stale: PanelEvent = {
      kind: "draft-leave-elapsed",
      token: before.draftLeave ?? -1,
    };
    expect(panelReducer(after, stale).open).toBe(true);
  });

  it("holds the locked delays", () => {
    expect(panelDelays).toEqual({ dwellMs: 200, leaveMs: 300, draftMs: 3000 });
  });

  it("returns the same state when nothing changes", () => {
    const state = run(opened);
    expect(panelReducer(state, onNotch)).toBe(state);
  });
});
