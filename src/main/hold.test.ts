import { describe, expect, it } from "vitest";
import type { HoldState } from "../shared/ipc";
import { createHoldTracker } from "./hold";

const alt = 56;
const ctrl = 29;
const meta = 3675;
const space = 57;

type Step = ["down", number] | ["up", number] | ["reset"];

type Row = {
  name: string;
  keys: number[];
  steps: Step[];
  expected: HoldState[];
};

const rows: Row[] = [
  {
    name: "single key press and release",
    keys: [alt],
    steps: [
      ["down", alt],
      ["up", alt],
    ],
    expected: ["listening", "idle"],
  },
  {
    name: "key repeat while held gives one listening",
    keys: [alt],
    steps: [
      ["down", alt],
      ["down", alt],
      ["down", alt],
      ["up", alt],
    ],
    expected: ["listening", "idle"],
  },
  {
    name: "two-key combo needs both keys and stops when either is released",
    keys: [ctrl, meta],
    steps: [
      ["down", ctrl],
      ["down", meta],
      ["up", ctrl],
      ["down", ctrl],
      ["up", meta],
    ],
    expected: ["listening", "idle", "listening", "idle"],
  },
  {
    name: "an unrelated key never changes state",
    keys: [alt],
    steps: [
      ["down", space],
      ["up", space],
      ["down", alt],
      ["down", space],
      ["up", space],
      ["up", alt],
    ],
    expected: ["listening", "idle"],
  },
  {
    name: "empty keys never fire",
    keys: [],
    steps: [
      ["down", alt],
      ["down", space],
      ["up", space],
      ["up", alt],
    ],
    expected: [],
  },
  {
    name: "after reset a keyup gives nothing",
    keys: [alt],
    steps: [["down", alt], ["reset"], ["up", alt]],
    expected: ["listening"],
  },
];

describe("createHoldTracker", () => {
  it.each(rows)("$name", ({ keys, steps, expected }) => {
    const tracker = createHoldTracker(keys);
    const results: HoldState[] = [];
    for (const step of steps) {
      if (step[0] === "reset") {
        tracker.reset();
        continue;
      }
      const result =
        step[0] === "down" ? tracker.keyDown(step[1]) : tracker.keyUp(step[1]);
      if (result !== null) results.push(result);
    }
    expect(results).toEqual(expected);
  });
});
