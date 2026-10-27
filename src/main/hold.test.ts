import { describe, expect, it } from "vitest";
import { createHoldTracker, holdLimits } from "./hold";
import type { HoldOutcome } from "./hold";

const alt = 56;
const ctrl = 29;
const meta = 3675;
const shift = 42;
const space = 57;

const { longestMs } = holdLimits;

type Step =
  ["down", number, number] | ["up", number, number] | ["cap"] | ["reset"];

type Result = "listening" | HoldOutcome;

type Row = {
  name: string;
  keys: number[];
  steps: Step[];
  expected: Result[];
};

const rows: Row[] = [
  {
    name: "a normal hold is accepted",
    keys: [alt],
    steps: [
      ["down", alt, 0],
      ["up", alt, 1200],
    ],
    expected: ["listening", "accept"],
  },
  {
    name: "a 299 ms tap is discarded",
    keys: [alt],
    steps: [
      ["down", alt, 0],
      ["up", alt, 299],
    ],
    expected: ["listening", "discard"],
  },
  {
    name: "a hold of exactly 300 ms is accepted",
    keys: [alt],
    steps: [
      ["down", alt, 1000],
      ["up", alt, 1300],
    ],
    expected: ["listening", "accept"],
  },
  {
    name: "key repeat while held gives one listening and one outcome",
    keys: [alt],
    steps: [
      ["down", alt, 0],
      ["down", alt, 100],
      ["down", alt, 200],
      ["up", alt, 500],
    ],
    expected: ["listening", "accept"],
  },
  {
    name: "Windows combo needs both keys, ends when either is released, and its keys are never another key",
    keys: [ctrl, meta],
    steps: [
      ["down", ctrl, 0],
      ["down", meta, 100],
      ["up", ctrl, 600],
      ["down", ctrl, 700],
      ["up", meta, 800],
    ],
    expected: ["listening", "accept", "listening", "discard"],
  },
  {
    name: "another key pressed and released before the hold is harmless",
    keys: [alt],
    steps: [
      ["down", space, 0],
      ["up", space, 50],
      ["down", alt, 100],
      ["up", alt, 600],
    ],
    expected: ["listening", "accept"],
  },
  {
    name: "another key pressed and released during the hold discards it",
    keys: [alt],
    steps: [
      ["down", alt, 0],
      ["down", space, 200],
      ["up", space, 300],
      ["up", alt, 1000],
    ],
    expected: ["listening", "discard"],
  },
  {
    name: "another key held across the release discards the hold",
    keys: [alt],
    steps: [
      ["down", alt, 0],
      ["down", space, 200],
      ["up", alt, 1000],
      ["up", space, 1100],
    ],
    expected: ["listening", "discard"],
  },
  {
    name: "a modifier held before the hold key does not discard it",
    keys: [alt],
    steps: [
      ["down", shift, 0],
      ["down", alt, 100],
      ["up", alt, 600],
      ["up", shift, 700],
    ],
    expected: ["listening", "accept"],
  },
  {
    name: "the cap accepts an active hold; the later repeat and key-up give nothing",
    keys: [alt],
    steps: [
      ["down", alt, 0],
      ["cap"],
      ["down", alt, longestMs + 100],
      ["up", alt, longestMs + 500],
    ],
    expected: ["listening", "accept"],
  },
  {
    name: "after the cap another key starts no hold; releasing and pressing the hold key again does",
    keys: [alt],
    steps: [
      ["down", alt, 0],
      ["cap"],
      ["down", space, longestMs + 100],
      ["up", space, longestMs + 200],
      ["up", alt, longestMs + 300],
      ["down", alt, longestMs + 400],
      ["up", alt, longestMs + 1400],
    ],
    expected: ["listening", "accept", "listening", "accept"],
  },
  {
    name: "the cap accepts even when another key was pressed",
    keys: [alt],
    steps: [["down", alt, 0], ["down", space, 100], ["cap"]],
    expected: ["listening", "accept"],
  },
  {
    name: "the cap with no active hold gives nothing",
    keys: [alt],
    steps: [["cap"], ["down", alt, 0], ["up", alt, 500], ["cap"]],
    expected: ["listening", "accept"],
  },
  {
    name: "empty keys never fire",
    keys: [],
    steps: [
      ["down", alt, 0],
      ["down", space, 100],
      ["up", space, 200],
      ["up", alt, 1000],
    ],
    expected: [],
  },
  {
    name: "after reset mid-hold a keyup gives nothing",
    keys: [alt],
    steps: [["down", alt, 0], ["reset"], ["up", alt, 1000]],
    expected: ["listening"],
  },
];

function runStep(
  tracker: ReturnType<typeof createHoldTracker>,
  step: Step,
): Result | null {
  switch (step[0]) {
    case "down":
      return tracker.keyDown(step[1], step[2]);
    case "up":
      return tracker.keyUp(step[1], step[2]);
    case "cap":
      return tracker.endAtCap();
    case "reset":
      tracker.reset();
      return null;
  }
}

describe("createHoldTracker", () => {
  it.each(rows)("$name", ({ keys, steps, expected }) => {
    const tracker = createHoldTracker(keys);
    const results: Result[] = [];
    for (const step of steps) {
      const result = runStep(tracker, step);
      if (result !== null) results.push(result);
    }
    expect(results).toEqual(expected);
  });
});
