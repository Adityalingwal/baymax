import { describe, expect, it } from "vitest";
import type { VoicePhase } from "../../../src/shared/ipc";
import {
  initialPill,
  islandShown,
  pillDelays,
  pillReducer,
} from "../../../src/renderer/notch/pill";
import type {
  PillClose,
  PillEvent,
  PillState,
  PillWord,
} from "../../../src/renderer/notch/pill";

type Step = PillEvent | ((state: PillState) => PillEvent);

const phase = (voice: VoicePhase, answer = false): PillEvent => ({
  kind: "phase",
  phase: voice,
  answer,
});
const listening = phase({ phase: "listening" });
const thinking = phase({ phase: "thinking" });
const idle = phase({ phase: "idle" });
const speaking = phase({
  phase: "speaking",
  line: { lineId: "l1", taskId: "t1", kind: "answer" },
});
const mute: PillEvent = { kind: "mute-clicked" };
const mainMuted: PillEvent = { kind: "main-muted", muted: true };
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
  label?: PillState["clearLabel"];
  closing?: boolean; // the 800 ms hold is running
  close?: PillClose;
};

const rows: { name: string; steps: Step[]; expected: Expected }[] = [
  {
    name: "a hold past 50 ms shows Listening",
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
    name: "a key held over Speaking keeps the word until 50 ms",
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
    expected: { shown: true, label: "Muted", closing: true },
  },
  {
    name: "the speech ending after a mute does not restart the hold",
    steps: [speaking, mute, idle, hold],
    expected: { shown: false, label: "Muted" },
  },
  {
    name: "a turn that ends in Thinking closes the pill at once, in the fast close",
    steps: [listening, threshold, thinking, idle],
    expected: { shown: false, closing: false, close: "silent" },
  },
  {
    name: "muted, a turn that ends in Thinking keeps the soft close",
    steps: [mainMuted, listening, threshold, thinking, idle],
    expected: { shown: false, closing: false, close: "soft" },
  },
  {
    name: "a tap longer than 50 ms shows the pill and closes it at once",
    steps: [listening, threshold, idle],
    expected: { shown: false, closing: false, close: "silent" },
  },
  {
    name: "after speech the close stays soft",
    steps: [listening, threshold, thinking, speaking, idle, hold],
    expected: { shown: false, close: "soft" },
  },
  {
    name: "a new opening forgets the last fast close",
    steps: [listening, threshold, thinking, idle, speaking],
    expected: { shown: true, close: "soft" },
  },
  {
    name: "a new turn after a failed Thinking opens the pill again",
    steps: [listening, threshold, thinking, idle, listening, threshold],
    expected: { shown: true, word: "Listening" },
  },
  {
    name: "mute does nothing unless Baymax speaks",
    steps: [listening, threshold, thinking, mute],
    expected: { shown: true, label: null, closing: false },
  },
];

describe("pillReducer", () => {
  it.each(rows)("$name", ({ steps, expected }) => {
    const state = run(steps);
    expect({
      shown: state.shown,
      ...(expected.word === undefined ? {} : { word: state.word }),
      ...(expected.label === undefined ? {} : { label: state.clearLabel }),
      ...(expected.closing === undefined
        ? {}
        : { closing: state.wait?.kind === "hold" }),
      ...(expected.close === undefined ? {} : { close: state.close }),
    }).toEqual(expected);
  });

  it("toggles on two clicks in a row, following main's mute, with the 800 ms from each click", () => {
    const once = run([speaking, mute, mainMuted, idle]);
    const twice = pillReducer(once, mute);
    expect(once.clearLabel).toBe("Muted");
    expect(twice.clearLabel).toBe("Unmuted");
    expect(twice.wait?.token).not.toBe(once.wait?.token);
    expect(pillReducer(twice, staleHold(once.wait?.token ?? -1)).shown).toBe(
      true,
    );
    const unmuted = pillReducer(twice, { kind: "main-muted", muted: false });
    expect(pillReducer(unmuted, mute).clearLabel).toBe("Muted");
  });

  it("holds the locked delays", () => {
    expect(pillDelays).toEqual({ thresholdMs: 50, holdMs: 800 });
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

const answer = (lineId: string): PillEvent =>
  phase(
    { phase: "speaking", line: { lineId, taskId: "t1", kind: "answer" } },
    true,
  );
const openResult: PillEvent = { kind: "open-result" };

type IslandRow = {
  name: string;
  steps: Step[];
  island: boolean;
  shown: boolean;
  holding?: boolean;
};

// The answer island must never get stuck: every way out leaves no island and no stray hold.
const islandRows: IslandRow[] = [
  {
    name: "a done task's answer shows the island",
    steps: [answer("a1")],
    island: true,
    shown: true,
  },
  {
    name: "its line ending closes the island at once, with no 800 ms hold",
    steps: [answer("a1"), idle],
    island: false,
    shown: false,
    holding: false,
  },
  {
    name: "a stale pill hold timer firing after the island replaced the pill does nothing",
    steps: [speaking, idle, answer("a1"), staleHold(1)],
    island: true,
    shown: true,
  },
  {
    name: "a new answer line while the island grows keeps the island for it",
    steps: [answer("a1"), answer("a2")],
    island: true,
    shown: true,
  },
  {
    name: "a new answer line while the island closes opens it again",
    steps: [answer("a1"), idle, answer("a2")],
    island: true,
    shown: true,
  },
  {
    name: "a plain line after the island shows the pill",
    steps: [answer("a1"), idle, speaking],
    island: false,
    shown: true,
  },
  {
    name: "mute on the island starts no hold, and the line's end closes it",
    steps: [answer("a1"), mute, idle],
    island: false,
    shown: false,
    holding: false,
  },
  {
    name: "the hold key closes the island at once",
    steps: [answer("a1"), listening],
    island: false,
    shown: false,
  },
  {
    name: "a tap over the island leaves nothing behind",
    steps: [answer("a1"), listening, idle],
    island: false,
    shown: false,
    holding: false,
  },
  {
    name: "a real hold over the island shows Listening",
    steps: [answer("a1"), listening, threshold],
    island: false,
    shown: true,
  },
  {
    name: "a click on the card ends the island; the line goes on as a pill line",
    steps: [answer("a1"), openResult],
    island: false,
    shown: true,
  },
  {
    name: "after a click the line's end uses the pill's 800 ms hold",
    steps: [answer("a1"), openResult, idle],
    island: false,
    shown: true,
    holding: true,
  },
];

describe("the answer island in pillReducer", () => {
  it.each(islandRows)("$name", ({ steps, island, shown, holding }) => {
    const state = run(steps);
    expect(islandShown(state)).toBe(island);
    expect(state.shown).toBe(shown);
    if (holding !== undefined) {
      expect(state.wait?.kind === "hold").toBe(holding);
    }
  });
});
