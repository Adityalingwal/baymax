import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe('"One moment."', () => {
  it("goes ahead of the lines waiting, behind the line playing", async () => {
    const h = createHarness();
    const blocker = await play(h, said("blocker", "t2"));
    h.speech.speak(said("Talker line.", "t1", "talk"));
    h.speech.sayMoment("k1");
    finish(h, blocker);
    expect(h.texts()).toEqual(["blocker", "One moment."]);
  });
});
