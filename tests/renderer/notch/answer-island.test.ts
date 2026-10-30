import { describe, expect, it } from "vitest";
import type { SpokenKind, VoicePhase } from "../../../src/shared/ipc";
import {
  initialIsland,
  islandReducer,
  islandSpeaks,
} from "../../../src/renderer/notch/answer-island";
import type {
  IslandEvent,
  IslandState,
} from "../../../src/renderer/notch/answer-island";

type Step = IslandEvent | ((state: IslandState) => IslandEvent);

const speaking = (lineId: string, kind: SpokenKind): VoicePhase => ({
  phase: "speaking",
  line: { lineId, taskId: "t1", kind },
});
const phase = (voice: VoicePhase, eligible = false): IslandEvent => ({
  kind: "phase",
  phase: voice,
  eligible,
});
const result = phase(speaking("a1", "answer"), true);
const idle = phase({ phase: "idle" });
const listening = phase({ phase: "listening" });
const pointer = (on: boolean): IslandEvent => ({ kind: "pointer", on });
const panel = (open: boolean): IslandEvent => ({ kind: "panel", open });
const toggleReport: IslandEvent = { kind: "toggle-report" };
const fold: IslandEvent = { kind: "fold" };
// The running timer fires.
const closeTimer: Step = (state) => ({
  kind: "close-elapsed",
  token: state.wait?.token ?? -1,
});
const closingTimer: Step = (state) => ({
  kind: "closing-elapsed",
  token: state.wait?.token ?? -1,
});

function run(steps: Step[]): IslandState {
  return steps.reduce<IslandState>((state, step) => {
    const event = typeof step === "function" ? step(state) : step;
    return islandReducer(state, event);
  }, initialIsland);
}

type Row = {
  name: string;
  steps: Step[];
  shown: boolean;
  wait?: "close" | "closing" | null;
  closed?: string | null;
};

const rows: Row[] = [
  {
    name: "a background task's result shows the island",
    steps: [result],
    shown: true,
    wait: null,
  },
  {
    name: "a chat reply never does",
    steps: [phase(speaking("l1", "talk"))],
    shown: false,
    wait: null,
  },
  {
    name: "a failed task's line never does",
    steps: [phase(speaking("l1", "failure"))],
    shown: false,
    wait: null,
  },
  {
    name: "a result line that is not eligible shows nothing, but still reports after it ends",
    steps: [phase(speaking("a1", "answer"), false), idle, closingTimer],
    shown: false,
    closed: "a1",
  },
  {
    name: "a result that starts with the panel open has no island, and reports after it ends",
    steps: [panel(true), result, idle, closingTimer],
    shown: false,
    closed: "a1",
  },
  {
    name: "the line's end starts the 2 s, and the island stays until they pass",
    steps: [result, idle],
    shown: true,
    wait: "close",
  },
  {
    name: "the 2 s passing closes it, and main is not told before the close motion has run",
    steps: [result, idle, closeTimer],
    shown: false,
    wait: "closing",
    closed: null,
  },
  {
    name: "the close motion ending tells main",
    steps: [result, idle, closeTimer, closingTimer],
    shown: false,
    wait: null,
    closed: "a1",
  },
  {
    name: "the 2 s do not count with the pointer on it",
    steps: [result, pointer(true), idle],
    shown: true,
    wait: null,
  },
  {
    name: "the pointer coming on stops the 2 s, and a timer already fired does nothing",
    steps: [result, idle, pointer(true), { kind: "close-elapsed", token: 1 }],
    shown: true,
    wait: null,
  },
  {
    name: "the pointer leaving counts the 2 s again",
    steps: [result, pointer(true), idle, pointer(false)],
    shown: true,
    wait: "close",
  },
  {
    name: "the key closes it at once, even with the pointer on it",
    steps: [result, pointer(true), listening],
    shown: false,
    wait: "closing",
  },
  {
    name: "a click that opens the panel closes it, and the report waits for the line's end",
    steps: [result, panel(true)],
    shown: false,
    wait: null,
  },
  {
    name: "another line during the 2 s leaves them running",
    steps: [result, idle, phase(speaking("l2", "failure"))],
    shown: true,
    wait: "close",
  },
  {
    name: "the same phase sent again changes nothing",
    steps: [result, result],
    shown: true,
    wait: null,
  },
  {
    name: "an open report holds it past the line's end, with the pointer off",
    steps: [result, toggleReport, idle],
    shown: true,
    wait: null,
  },
  {
    name: "folding by the button counts the 2 s again",
    steps: [result, toggleReport, idle, toggleReport],
    shown: true,
    wait: "close",
  },
  {
    name: "folding by Esc counts the 2 s again",
    steps: [result, toggleReport, idle, fold],
    shown: true,
    wait: "close",
  },
  {
    name: "the key leaves an open report up",
    steps: [result, toggleReport, listening],
    shown: true,
    wait: null,
  },
  {
    name: "the next result gets its own island after the first has closed",
    steps: [
      result,
      idle,
      closeTimer,
      closingTimer,
      phase(speaking("a2", "answer"), true),
    ],
    shown: true,
    wait: null,
  },
];

describe("the answer island", () => {
  it.each(rows)("$name", ({ steps, shown, wait, closed }) => {
    const state = run(steps);
    expect(state.shown).toBe(shown);
    if (wait !== undefined) expect(state.wait?.kind ?? null).toBe(wait);
    if (closed !== undefined) expect(state.closed).toBe(closed);
  });

  it("opens the next island with its report folded", () => {
    const closed = run([
      result,
      toggleReport,
      panel(true),
      panel(false),
      idle,
      closingTimer,
    ]);
    const next = islandReducer(closed, phase(speaking("a2", "answer"), true));
    expect(next.reportOpen).toBe(false);
  });

  it.each<{ name: string; steps: Step[]; voice: VoicePhase; speaks: boolean }>([
    {
      name: "its own line",
      steps: [result],
      voice: speaking("a1", "answer"),
      speaks: true,
    },
    {
      name: "its line after the panel opened over it",
      steps: [result, panel(true)],
      voice: speaking("a1", "answer"),
      speaks: false,
    },
    {
      name: "another line during its wait",
      steps: [result, idle],
      voice: speaking("l2", "talk"),
      speaks: false,
    },
  ])("islandSpeaks: $name, $speaks", ({ steps, voice, speaks }) => {
    expect(islandSpeaks(run(steps), voice)).toBe(speaks);
  });
});
