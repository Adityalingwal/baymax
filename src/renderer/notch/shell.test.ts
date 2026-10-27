import { describe, expect, it } from "vitest";
import type { TaskCard, TaskState } from "../../shared/cards";
import {
  foldedOrClosed,
  initialPointer,
  initialVoice,
  lastFoldedCard,
  pointerReducer,
  shellMode,
  voiceReducer,
} from "./shell";
import type {
  PointerChange,
  PointerState,
  ShellMode,
  ShellReasons,
  VoiceEvent,
  VoiceState,
} from "./shell";

type Card = Pick<TaskCard, "taskId" | "state" | "folded">;

const card = (taskId: string, state: TaskState, folded = false): Card => ({
  taskId,
  state,
  folded,
});

const openAnswer = card("open", "done");
const pill = card("pill", "running");
const question = card("question", "clarifying");
const folded = card("folded", "done", true);
const foldedIncomplete = card("folded-2", "incomplete", true);

const quiet: ShellReasons & PointerState = {
  typing: false,
  voice: false,
  notice: null,
  tasks: [],
  hovered: false,
  waitForExit: false,
};

type ModeRow = {
  name: string;
  input: Partial<typeof quiet>;
  expected: ShellMode;
};

const modeRows: ModeRow[] = [
  { name: "nothing to show is idle", input: {}, expected: "idle" },
  { name: "hover opens", input: { hovered: true }, expected: "open" },
  { name: "typing opens", input: { typing: true }, expected: "open" },
  { name: "voice opens", input: { voice: true }, expected: "open" },
  {
    name: "a notice opens",
    input: { notice: "I didn't catch that, say it again." },
    expected: "open",
  },
  {
    name: "an open answer opens",
    input: { tasks: [openAnswer] },
    expected: "open",
  },
  { name: "a pill opens", input: { tasks: [pill] }, expected: "open" },
  {
    name: "a question opens",
    input: { tasks: [question] },
    expected: "open",
  },
  {
    name: "one unfolded card among folded ones opens",
    input: { tasks: [folded, pill] },
    expected: "open",
  },
  {
    name: "only folded cards show the dot",
    input: { tasks: [folded, foldedIncomplete] },
    expected: "dot",
  },
  {
    name: "wait-for-exit keeps hover alone from opening",
    input: { hovered: true, waitForExit: true },
    expected: "idle",
  },
  {
    name: "wait-for-exit with folded cards shows the dot",
    input: { hovered: true, waitForExit: true, tasks: [folded] },
    expected: "dot",
  },
  {
    name: "wait-for-exit does not close a shell held open by a card",
    input: { hovered: true, waitForExit: true, tasks: [pill] },
    expected: "open",
  },
  {
    name: "wait-for-exit does not close a shell held open by typing",
    input: { waitForExit: true, typing: true },
    expected: "open",
  },
];

describe("shellMode", () => {
  it.each(modeRows)("$name", ({ input, expected }) => {
    expect(shellMode({ ...quiet, ...input })).toBe(expected);
  });
});

describe("lastFoldedCard", () => {
  it.each<{ name: string; tasks: Card[]; expected: Card | null }>([
    { name: "no cards", tasks: [], expected: null },
    { name: "no folded card", tasks: [openAnswer, pill], expected: null },
    { name: "one folded card", tasks: [folded], expected: folded },
    {
      name: "the last folded card in tasks order wins",
      tasks: [folded, foldedIncomplete],
      expected: foldedIncomplete,
    },
    {
      name: "folded and unfolded mixed",
      tasks: [folded, openAnswer, foldedIncomplete, pill],
      expected: foldedIncomplete,
    },
  ])("$name", ({ tasks, expected }) => {
    expect(lastFoldedCard(tasks)).toBe(expected);
  });
});

describe("foldedOrClosed", () => {
  it.each<[string, Card[], Card[], boolean]>([
    [
      "a shown card was folded",
      [openAnswer],
      [{ ...openAnswer, folded: true }],
      true,
    ],
    ["a shown card was closed", [openAnswer, folded], [folded], true],
    ["a folded card was closed", [folded], [], false],
    ["a card was unfolded", [folded], [{ ...folded, folded: false }], false],
    ["a card was added", [], [pill], false],
    ["a card changed state", [pill], [{ ...pill, state: "done" }], false],
  ])("%s", (_name, previous, current, expected) => {
    expect(foldedOrClosed(previous, current)).toBe(expected);
  });
});

const hovered: PointerState = { hovered: true, waitForExit: false };
const waiting: PointerState = { hovered: false, waitForExit: true };

type PointerRow = {
  name: string;
  state: PointerState;
  event: PointerChange["kind"];
  expected: PointerState;
};

const pointerRows: PointerRow[] = [
  {
    name: "inside hovers",
    state: initialPointer,
    event: "inside",
    expected: hovered,
  },
  {
    name: "inside while waiting for exit does not hover",
    state: waiting,
    event: "inside",
    expected: waiting,
  },
  {
    name: "outside after the delay stops hovering",
    state: hovered,
    event: "outside-after-delay",
    expected: initialPointer,
  },
  {
    name: "blur stops hovering",
    state: hovered,
    event: "blur",
    expected: initialPointer,
  },
  {
    name: "blur keeps waiting for exit",
    state: waiting,
    event: "blur",
    expected: waiting,
  },
  {
    name: "leaving the window stops hovering and waiting",
    state: { hovered: true, waitForExit: true },
    event: "left-window",
    expected: initialPointer,
  },
  {
    name: "a fold or close under the pointer waits for exit",
    state: hovered,
    event: "folded-or-closed",
    expected: waiting,
  },
  {
    name: "a fold or close away from the pointer does not wait",
    state: initialPointer,
    event: "folded-or-closed",
    expected: initialPointer,
  },
  {
    name: "leaving the collapsed outline ends the wait",
    state: waiting,
    event: "outside-collapsed",
    expected: initialPointer,
  },
];

describe("pointerReducer", () => {
  it.each(pointerRows)("$name", ({ state, event, expected }) => {
    expect(pointerReducer(state, { kind: event })).toEqual(expected);
  });

  it("returns the same state when nothing changes", () => {
    expect(pointerReducer(hovered, { kind: "inside" })).toBe(hovered);
  });
});

function runVoice(events: VoiceEvent[]): VoiceState {
  return events.reduce(voiceReducer, initialVoice);
}

const started: VoiceEvent = { kind: "listening-started" };
const ended: VoiceEvent = { kind: "listening-ended" };
const threshold = (hold: number): VoiceEvent => ({
  kind: "threshold-elapsed",
  hold,
});
const linger = (hold: number): VoiceEvent => ({ kind: "linger-elapsed", hold });

describe("voiceReducer", () => {
  it.each<{ name: string; events: VoiceEvent[]; voice: boolean }>([
    {
      name: "a tap never turns voice on",
      events: [started, ended, threshold(1)],
      voice: false,
    },
    {
      name: "a long hold turns voice on at the threshold",
      events: [started, threshold(1)],
      voice: true,
    },
    {
      name: "voice stays on after the hold until the linger elapses",
      events: [started, threshold(1), ended],
      voice: true,
    },
    {
      name: "the linger turns voice off",
      events: [started, threshold(1), ended, linger(1)],
      voice: false,
    },
    {
      name: "a new hold during the linger keeps voice on",
      events: [started, threshold(1), ended, started, linger(1)],
      voice: true,
    },
    {
      name: "a stale linger after a later hold ended is ignored",
      events: [started, threshold(1), ended, started, ended, linger(1)],
      voice: true,
    },
    {
      name: "a stale threshold from an earlier tap is ignored",
      events: [started, ended, started, threshold(1)],
      voice: false,
    },
  ])("$name", ({ events, voice }) => {
    expect(runVoice(events).voice).toBe(voice);
  });
});
