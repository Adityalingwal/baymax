import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "./speech.harness";
import {
  audio,
  createHarness,
  failure,
  finish,
  play,
  resolveCall,
  said,
} from "./speech.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("speak plays one line at a time", () => {
  it("the second line is synthesized only after the first finished, each with its own text", async () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    expect(h.texts()).toEqual(["first"]);
    await resolveCall(h, 0, audio(7));
    expect(h.speeches).toHaveLength(1);
    expect([...new Uint8Array(h.speeches[0].audio)]).toEqual([7]);
    expect(h.speeches[0].mimeType).toBe("audio/mpeg");
    expect(h.texts()).toEqual(["first"]);

    finish(h, h.speeches[0].lineId);
    expect(h.texts()).toEqual(["first", "second"]);
    await resolveCall(h, 1, audio(8));
    expect([...new Uint8Array(h.speeches[1].audio)]).toEqual([8]);
    expect(h.speeches[1].lineId).not.toBe(h.speeches[0].lineId);
  });

  it("a late report for an old line never ends the line playing now", async () => {
    const h = createHarness();
    const old = await play(h, said("first"));
    h.speech.holdStarted();
    h.speech.holdEnded();
    const current = await play(h, said("second"));
    h.speech.speak(said("third"));
    h.speech.playbackFinished({ lineId: old, outcome: "stopped" });
    expect(h.texts()).toEqual(["first", "second"]);
    expect(h.timers[1].cancelled).toBe(false);

    finish(h, current);
    expect(h.texts()).toEqual(["first", "second", "third"]);
  });

  it("a failed playback report ends the line, is logged, and the next line plays", async () => {
    const h = createHarness();
    const lineId = await play(h, said("first"));
    h.speech.speak(said("second"));
    h.speech.playbackFinished({ lineId, outcome: "failed" });
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] playback failed"),
    );
  });
});

const endings: { name: string; end: (h: Harness, lineId: string) => void }[] = [
  { name: "finish", end: (h, lineId) => finish(h, lineId) },
  { name: "hold", end: (h) => h.speech.holdStarted() },
  { name: "mute", end: (h) => h.speech.setMuted(true) },
  { name: "cancel", end: (h) => h.speech.cancelTask("t1") },
  { name: "renderer reset", end: (h) => h.speech.rendererReset() },
];

describe("the playback deadline", () => {
  it("is set with exactly 60 000 ms when a line is sent", async () => {
    const h = createHarness();
    await play(h, said("first"));
    expect(h.timers.map((timer) => timer.ms)).toEqual([60_000]);
  });

  it("firing on the stuck line stops it and plays the next", async () => {
    const h = createHarness();
    const lineId = await play(h, said("first"));
    h.speech.speak(said("second"));
    h.timers[0].fire();
    expect(h.stops).toEqual([{ lineId }]);
    expect(h.texts()).toEqual(["first", "second"]);
  });

  it("an old deadline fired after its line ended does nothing", async () => {
    const h = createHarness();
    finish(h, await play(h, said("first")));
    await play(h, said("second"));
    h.speech.speak(said("third"));
    h.timers[0].fire();
    expect(h.stops).toEqual([]);
    expect(h.texts()).toEqual(["first", "second"]);
  });

  it.each(endings)("is cancelled on $name", async ({ end }) => {
    const h = createHarness();
    const lineId = await play(h, said("first"));
    expect(h.timers[0].cancelled).toBe(false);
    end(h, lineId);
    expect(h.timers[0].cancelled).toBe(true);
  });
});

describe("failures in the injected callbacks never escape", () => {
  it("a throwing sendSpeech is logged, ends that line, and the next plays", async () => {
    const h = createHarness();
    h.sendSpeech.mockImplementationOnce(() => {
      throw new Error("window gone");
    });
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    await resolveCall(h, 0);
    expect(h.timers[0].cancelled).toBe(true);
    expect(h.texts()).toEqual(["first", "second"]);
    await resolveCall(h, 1, audio(2));
    expect([...new Uint8Array(h.speeches[0].audio)]).toEqual([2]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] sendSpeech threw"),
    );
  });

  it("a throwing sendStop is logged and the queue goes on", async () => {
    const h = createHarness();
    h.sendStop.mockImplementationOnce(() => {
      throw new Error("window gone");
    });
    await play(h, said("first"));
    h.speech.holdStarted();
    h.speech.holdEnded();
    h.speech.speak(said("second"));
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] sendStop threw"),
    );
  });

  it("a throwing onVoiceAvailable is logged and the queue goes on", async () => {
    const h = createHarness();
    h.onVoiceAvailable.mockImplementationOnce(() => {
      throw new Error("display gone");
    });
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    await resolveCall(h, 0, failure("unreachable"));
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] onVoiceAvailable threw"),
    );
  });
});

describe("a callback that re-enters", () => {
  it("playbackFinished called from inside sendSpeech ends that line", async () => {
    const h = createHarness();
    h.sendSpeech.mockImplementationOnce((line) =>
      h.speech.playbackFinished({ lineId: line.lineId, outcome: "ended" }),
    );
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    await resolveCall(h, 0);
    expect(h.timers[0].cancelled).toBe(true);
    expect(h.texts()).toEqual(["first", "second"]);
    await resolveCall(h, 1, audio(2));
    expect(h.speeches).toHaveLength(1);
  });
});

describe("renderer reset", () => {
  it("drops the playing line with no stop and the pending lines; a later line plays", async () => {
    const h = createHarness();
    await play(h, said("first"));
    h.speech.speak(said("second"));
    h.speech.rendererReset();
    expect(h.stops).toEqual([]);
    expect(h.timers[0].cancelled).toBe(true);
    h.speech.speak(said("third"));
    expect(h.texts()).toEqual(["first", "third"]);
  });

  it("clears the held key, so a line said afterwards plays at once", () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.speak(said("during the hold"));
    h.speech.rendererReset();
    h.speech.speak(said("after"));
    expect(h.texts()).toEqual(["after"]);
  });
});
