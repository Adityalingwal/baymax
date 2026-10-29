import { describe, expect, it } from "vitest";
import { initialPanel, panelReducer } from "./shell";
import type { PanelEvent, PanelState } from "./shell";

type Step = PanelEvent | ((state: PanelState) => PanelEvent);

const pointer = (
  inNotch: boolean,
  inOpenOutline: boolean,
  inVisible: boolean,
): PanelEvent => ({ kind: "pointer", inNotch, inOpenOutline, inVisible });

const onNotch = pointer(true, true, true);
const onPanel = pointer(false, true, true);
// Inside the open outline but where nothing is drawn yet (or any more).
const onUndrawn = pointer(false, true, false);
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
const escape: PanelEvent = { kind: "escape" };
const closed: PanelEvent = { kind: "closed" };
const draft = (value: boolean): PanelEvent => ({ kind: "draft", draft: value });
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
};

const rows: { name: string; steps: Step[]; expected: Expected }[] = [
  {
    name: "resting 150 ms on the notch opens",
    steps: opened,
    expected: { open: true, dwelling: false, leaving: false },
  },
  {
    name: "leaving the notch before 150 ms cancels the dwell",
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
    name: "a draft blocks the hover-exit close",
    steps: [...opened, draft(true), away],
    expected: { open: true, leaving: false },
  },
  {
    name: "clearing the draft while out starts the close",
    steps: [...opened, draft(true), away, draft(false), leave],
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
    steps: [...opened, draft(true), escape],
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
    name: "the Accessibility hint opens the panel by itself",
    steps: [access],
    expected: { open: true },
  },
  {
    name: "the Accessibility hint holds through Esc and the pointer out",
    steps: [access, onPanel, escape, away],
    expected: { open: true, leaving: false },
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

describe("panelReducer", () => {
  it.each(rows)("$name", ({ steps, expected }) => {
    const state = run(steps);
    expect({
      open: state.open,
      ...(expected.closing === undefined ? {} : { closing: state.closing }),
      ...(expected.dwelling === undefined
        ? {}
        : { dwelling: state.dwell !== null }),
      ...(expected.leaving === undefined
        ? {}
        : { leaving: state.leave !== null }),
    }).toEqual(expected);
  });

  it("keeps the draft through an Esc close", () => {
    expect(run([...opened, draft(true), escape]).draft).toBe(true);
  });

  it("returns the same state when nothing changes", () => {
    const state = run(opened);
    expect(panelReducer(state, onNotch)).toBe(state);
  });
});
