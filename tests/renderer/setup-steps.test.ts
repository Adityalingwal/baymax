import { describe, expect, it } from "vitest";
import {
  nextChecklistStage,
  noClicks,
  setupCanEnd,
  setupReady,
  setupRows,
} from "../../src/renderer/setup-steps";
import type { SetupClicks, SetupRow } from "../../src/renderer/setup-steps";
import type { SetupState } from "../../src/shared/ipc";

type Shown = Pick<SetupRow, "icon" | "hint" | "dimmed"> & {
  button: string | null;
};

type Row = {
  name: string;
  accessibility: SetupState["accessibility"];
  microphone: SetupState["microphone"];
  clicks?: Partial<SetupClicks>;
  row: 0 | 1;
  shown: Shown;
};

const onSwitch = "Switch on Electron";
const inSettings = "Switch on Electron in Microphone settings";
const done: Shown = { icon: "done", hint: null, button: null, dimmed: false };

const rows: Row[] = [
  {
    name: "Accessibility pending",
    accessibility: "missing",
    microphone: "ask",
    row: 0,
    shown: {
      icon: "pending",
      hint: onSwitch,
      button: "Open settings",
      dimmed: false,
    },
  },
  {
    name: "Accessibility waiting after its click",
    accessibility: "missing",
    microphone: "ask",
    clicks: { accessibility: true },
    row: 0,
    shown: { icon: "waiting", hint: onSwitch, button: null, dimmed: false },
  },
  {
    name: "Accessibility done",
    accessibility: "granted",
    microphone: "ask",
    clicks: { accessibility: true },
    row: 0,
    shown: done,
  },
  {
    name: "Accessibility failed names the way out",
    accessibility: "failed",
    microphone: "granted",
    clicks: { accessibility: true },
    row: 0,
    shown: {
      icon: "pending",
      hint: "Quit and run npm start again",
      button: null,
      dimmed: false,
    },
  },
  {
    name: "Microphone dimmed while Accessibility is missing",
    accessibility: "missing",
    microphone: "ask",
    row: 1,
    shown: { icon: "pending", hint: null, button: null, dimmed: true },
  },
  {
    name: "Microphone denied while Accessibility is missing: dimmed, its true hint, no button",
    accessibility: "missing",
    microphone: "denied",
    row: 1,
    shown: { icon: "pending", hint: inSettings, button: null, dimmed: true },
  },
  {
    name: "Microphone granted first shows its check, not dimmed",
    accessibility: "missing",
    microphone: "granted",
    row: 1,
    shown: done,
  },
  {
    name: "Microphone not asked, pending",
    accessibility: "granted",
    microphone: "ask",
    row: 1,
    shown: {
      icon: "pending",
      hint: "Choose Allow",
      button: "Allow",
      dimmed: false,
    },
  },
  {
    name: "Microphone not asked, waiting after its click",
    accessibility: "granted",
    microphone: "ask",
    clicks: { microphone: "ask" },
    row: 1,
    shown: {
      icon: "waiting",
      hint: "Choose Allow",
      button: null,
      dimmed: false,
    },
  },
  {
    name: "Microphone denied, pending",
    accessibility: "granted",
    microphone: "denied",
    row: 1,
    shown: {
      icon: "pending",
      hint: inSettings,
      button: "Open settings",
      dimmed: false,
    },
  },
  {
    name: "a denial in the popup ends the Allow click's wait",
    accessibility: "granted",
    microphone: "denied",
    clicks: { microphone: "ask" },
    row: 1,
    shown: {
      icon: "pending",
      hint: inSettings,
      button: "Open settings",
      dimmed: false,
    },
  },
  {
    name: "Microphone denied, waiting after its click",
    accessibility: "granted",
    microphone: "denied",
    clicks: { microphone: "denied" },
    row: 1,
    shown: { icon: "waiting", hint: inSettings, button: null, dimmed: false },
  },
  {
    name: "Microphone done",
    accessibility: "granted",
    microphone: "granted",
    clicks: { microphone: "ask" },
    row: 1,
    shown: done,
  },
];

describe("what each setup row shows", () => {
  it.each(rows)(
    "$name",
    ({ accessibility, microphone, clicks, row, shown }) => {
      const state: SetupState = { needed: true, accessibility, microphone };
      const { icon, hint, button, dimmed } = setupRows(state, {
        ...noClicks,
        ...clicks,
      })[row];
      expect({ icon, hint, dimmed, button: button?.label ?? null }).toEqual(
        shown,
      );
    },
  );
});

describe("the end of setup", () => {
  const ready: SetupState = {
    needed: true,
    accessibility: "granted",
    microphone: "granted",
  };

  it.each<{
    name: string;
    state: SetupState;
    keyMissing: boolean;
    can: boolean;
  }>([
    { name: "ready", state: ready, keyMissing: false, can: true },
    { name: "a missing key", state: ready, keyMissing: true, can: false },
    {
      name: "setup not needed",
      state: { ...ready, needed: false },
      keyMissing: false,
      can: false,
    },
    {
      name: "the microphone still missing",
      state: { ...ready, microphone: "ask" },
      keyMissing: false,
      can: false,
    },
  ])("the first hold with $name: $can", ({ state, keyMissing, can }) => {
    expect(setupCanEnd(state, keyMissing)).toBe(can);
  });

  it("keeps the checklist through one close, then the normal panel stays for good", () => {
    const opens = [true, false, true, false, true];
    const stages = opens.reduce<ReturnType<typeof nextChecklistStage>[]>(
      (seen, open) => [
        ...seen,
        nextChecklistStage(seen.at(-1) ?? "setup", true, open),
      ],
      [],
    );
    expect(stages).toEqual(["ended", "closed", "gone", "gone", "gone"]);
    expect(nextChecklistStage("setup", false, true)).toBe("setup");
  });
});

describe("the Ready flag", () => {
  it.each<{
    accessibility: SetupState["accessibility"];
    microphone: SetupState["microphone"];
    ready: boolean;
  }>([
    { accessibility: "granted", microphone: "granted", ready: true },
    { accessibility: "granted", microphone: "ask", ready: false },
    { accessibility: "missing", microphone: "granted", ready: false },
    { accessibility: "failed", microphone: "granted", ready: false },
  ])(
    "$accessibility and $microphone: $ready",
    ({ accessibility, microphone, ready }) => {
      expect(setupReady({ needed: true, accessibility, microphone })).toBe(
        ready,
      );
    },
  );
});
