import { describe, expect, it } from "vitest";
import type { VoicePhase } from "../../shared/ipc";
import { initialPill, pillReducer } from "./pill";
import type { PillEvent, PillState, PillWord } from "./pill";

type Step = PillEvent | ((state: PillState) => PillEvent);

const phase = (voice: VoicePhase): PillEvent => ({
  kind: "phase",
  phase: voice,
});
const listening = phase({ phase: "listening" });
const thinking = phase({ phase: "thinking" });
const idle = phase({ phase: "idle" });
const speaking = phase({
  phase: "speaking",
  line: { lineId: "l1", taskId: "t1", kind: "answer" },
});
const mute: PillEvent = { kind: "mute-clicked" };
// The running timer fires.
const threshold: Step = (state) => ({
  kind: "threshold-elapsed",
  token: state.wait?.token ?? -1,
});
const hold: Step = (state) => ({
  kind: "hold-elapsed",
  token: state.wait?.token ?? -1,
});
const staleHold = (token: number): PillEvent => ({
  kind: "hold-elapsed",
  token,
});

function run(steps: Step[]): PillState {
  return steps.reduce<PillState>((state, step) => {
    const event = typeof step === "function" ? step(state) : step;
    return pillReducer(state, event);
  }, initialPill);
}

type Expected = {
  shown: boolean;
  word?: PillWord;
  muted?: boolean;
  closing?: boolean; // the 800 ms hold is running
};

const rows: { name: string; steps: Step[]; expected: Expected }[] = [
  {
    name: "a hold past 300 ms shows Listening",
    steps: [listening, threshold],
    expected: { shown: true, word: "Listening" },
  },
  {
    name: "a tap never shows the pill",
    steps: [listening, idle, { kind: "threshold-elapsed", token: 1 }],
    expected: { shown: false },
  },
  {
    name: "thinking swaps the word",
    steps: [listening, threshold, thinking],
    expected: { shown: true, word: "Thinking" },
  },
  {
    name: "speaking opens the pill straight in Speaking",
    steps: [speaking],
    expected: { shown: true, word: "Speaking" },
  },
  {
    name: "speech end holds the pill 800 ms",
    steps: [speaking, idle],
    expected: { shown: true, word: "Speaking", closing: true },
  },
  {
    name: "after the 800 ms hold the pill closes",
    steps: [speaking, idle, hold],
    expected: { shown: false },
  },
  {
    name: "a new phase during the hold keeps the pill",
    steps: [speaking, idle, thinking, staleHold(1)],
    expected: { shown: true, word: "Thinking", closing: false },
  },
  {
    name: "a new line while the pill closes opens it again",
    steps: [speaking, idle, hold, speaking],
    expected: { shown: true, word: "Speaking" },
  },
  {
    name: "a key held over Speaking keeps the word until 300 ms",
    steps: [speaking, listening],
    expected: { shown: true, word: "Speaking", closing: false },
  },
  {
    name: "then shows Listening",
    steps: [speaking, listening, threshold],
    expected: { shown: true, word: "Listening" },
  },
  {
    name: "a tap over Speaking silences it and the pill closes after 800 ms",
    steps: [speaking, listening, idle],
    expected: { shown: true, closing: true },
  },
  {
    name: "mute while speaking shows Muted and starts the 800 ms hold",
    steps: [speaking, mute],
    expected: { shown: true, muted: true, closing: true },
  },
  {
    name: "the speech ending after a mute does not restart the hold",
    steps: [speaking, mute, idle, hold],
    expected: { shown: false, muted: true },
  },
  {
    name: "mute does nothing unless Baymax speaks",
    steps: [listening, threshold, thinking, mute],
    expected: { shown: true, muted: false, closing: false },
  },
];

describe("pillReducer", () => {
  it.each(rows)("$name", ({ steps, expected }) => {
    const state = run(steps);
    expect({
      shown: state.shown,
      ...(expected.word === undefined ? {} : { word: state.word }),
      ...(expected.muted === undefined ? {} : { muted: state.muted }),
      ...(expected.closing === undefined
        ? {}
        : { closing: state.wait?.kind === "hold" }),
    }).toEqual(expected);
  });

  it("never unmutes on a second click, and keeps the hold from the first", () => {
    const once = run([speaking, mute]);
    const twice = pillReducer(once, mute);
    expect(twice).toBe(once);
  });

  it("counts the mute hold from the click, not from the speech end", () => {
    const muted = run([speaking, mute]);
    expect(pillReducer(muted, idle).wait).toEqual(muted.wait);
  });

  it("counts an opening once, not a word change", () => {
    expect(run([speaking, thinking]).session).toBe(1);
    expect(run([speaking, idle, hold, speaking]).session).toBe(2);
  });

  it("keeps the speaking line for the island", () => {
    expect(run([speaking]).line).toEqual({
      lineId: "l1",
      taskId: "t1",
      kind: "answer",
    });
    expect(run([speaking, idle]).line).toBeNull();
  });
});
