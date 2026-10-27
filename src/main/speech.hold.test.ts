import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaidKind } from "./tasks/state";
import type { Harness } from "./speech.harness";
import {
  createHarness,
  finish,
  play,
  resolveCall,
  said,
} from "./speech.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("hold", () => {
  it("nothing is synthesized or sent while held; lines said during the hold play after release", async () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    expect(h.texts()).toEqual([]);
    h.speech.holdEnded();
    expect(h.texts()).toEqual(["first"]);
    await resolveCall(h, 0);
    finish(h, h.speeches[0].lineId);
    expect(h.texts()).toEqual(["first", "second"]);
  });

  it("a second key-down clears again, including lines said during the hold", () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.speak(said("during the first hold"));
    h.speech.holdStarted();
    h.speech.holdEnded();
    expect(h.texts()).toEqual([]);
  });

  it("a release when not held changes nothing", () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    h.speech.holdEnded();
    expect(h.calls[0].signal.aborted).toBe(false);
    expect(h.texts()).toEqual(["first"]);
  });
});

const holdAndMute: { name: string; steps: (h: Harness) => void }[] = [
  {
    name: "hold, then mute",
    steps: (h) => {
      h.speech.holdStarted();
      h.speech.setMuted(true);
    },
  },
  {
    name: "mute, then hold",
    steps: (h) => {
      h.speech.setMuted(true);
      h.speech.holdStarted();
    },
  },
];

describe("mute with hold", () => {
  it.each(holdAndMute)(
    "$name: a release while still muted plays nothing",
    ({ steps }) => {
      const h = createHarness();
      steps(h);
      h.speech.speak(said("while muted"));
      h.speech.holdEnded();
      h.speech.setMuted(false);
      expect(h.texts()).toEqual([]);
    },
  );
});

describe("mute alone", () => {
  it("drops every line said while muted, with no synthesis", () => {
    const h = createHarness();
    h.speech.setMuted(true);
    h.speech.speak(said("while muted"));
    expect(h.synthesize).not.toHaveBeenCalled();
    h.speech.setMuted(false);
    h.speech.speak(said("after"));
    expect(h.texts()).toEqual(["after"]);
  });

  it("unmute replays nothing that was cleared", async () => {
    const h = createHarness();
    await play(h, said("playing"));
    h.speech.speak(said("pending"));
    h.speech.setMuted(true);
    h.speech.setMuted(false);
    expect(h.texts()).toEqual(["playing"]);
    expect(h.speeches).toHaveLength(1);
  });

  it("the same value twice is a no-op", async () => {
    const h = createHarness();
    const lineId = await play(h, said("playing"));
    h.speech.setMuted(false);
    expect(h.stops).toEqual([]);
    h.speech.setMuted(true);
    h.speech.setMuted(true);
    expect(h.stops).toEqual([{ lineId }]);
  });

  it("a line said while held but not muted waits through an unmute until release", () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.setMuted(true);
    h.speech.setMuted(false);
    h.speech.speak(said("held"));
    expect(h.texts()).toEqual([]);
    h.speech.holdEnded();
    expect(h.texts()).toEqual(["held"]);
  });
});

const letMeCheck = said("Let me check.", "t1", "letMeCheck");
const laterKinds: SaidKind[] = [
  "startLine",
  "question",
  "answer",
  "failure",
  "notice",
];

describe('"Let me check." pending', () => {
  it.each(laterKinds)(
    "a pending one is removed when the same task's %s line arrives",
    async (kind) => {
      // Without the later line, the pending one plays once the blocker ends.
      const control = createHarness();
      const controlBlocker = await play(control, said("other task", "t2"));
      control.speech.speak(letMeCheck);
      expect(control.texts()).toEqual(["other task"]);
      finish(control, controlBlocker);
      expect(control.texts()).toEqual(["other task", "Let me check."]);

      const h = createHarness();
      const blocker = await play(h, said("other task", "t2"));
      h.speech.speak(letMeCheck);
      h.speech.speak(said("Okay, looking at it.", "t1", kind));
      finish(h, blocker);
      expect(h.texts()).toEqual(["other task", "Okay, looking at it."]);
    },
  );
});

describe('"Let me check." in other states', () => {
  it("a synthesizing one is aborted and never sent", async () => {
    const h = createHarness();
    h.speech.speak(letMeCheck);
    h.speech.speak(said("Okay, looking at it.", "t1", "startLine"));
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.texts()).toEqual(["Let me check.", "Okay, looking at it."]);
    await resolveCall(h, 0);
    expect(h.speeches).toEqual([]);
    await resolveCall(h, 1);
    expect(h.speeches).toHaveLength(1);
  });

  it("a playing one is not stopped", async () => {
    const h = createHarness();
    const lineId = await play(h, letMeCheck);
    h.speech.speak(said("Okay, looking at it.", "t1", "startLine"));
    expect(h.stops).toEqual([]);
    expect(h.timers[0].cancelled).toBe(false);
    finish(h, lineId);
    expect(h.texts()).toEqual(["Let me check.", "Okay, looking at it."]);
  });

  it("another task's one is kept", async () => {
    const h = createHarness();
    const blocker = await play(h, said("blocker", "t3"));
    h.speech.speak(letMeCheck);
    h.speech.speak(said("Okay, looking at it.", "t2", "startLine"));
    finish(h, blocker);
    expect(h.texts()).toEqual(["blocker", "Let me check."]);
  });
});
