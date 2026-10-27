import { beforeEach, describe, expect, it, vi } from "vitest";
import { bytesIn, createHarness, flush } from "./playback.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("playback plays one line and reports it once", () => {
  it("a line plays with its exact bytes and its end reports ended once", async () => {
    const h = createHarness();
    h.speak("a", [3, 4, 5]);
    expect(h.plays).toHaveLength(1);
    expect(bytesIn(h.plays[0].audio)).toEqual([3, 4, 5]);
    h.plays[0].resolve();
    await flush();
    expect(h.reports).toEqual([]);
    h.plays[0].onEnded();
    h.plays[0].onEnded();
    expect(h.reports).toEqual([{ lineId: "a", outcome: "ended" }]);
    expect(h.player.stop).not.toHaveBeenCalled();
  });

  it("a stop for its id stops the player and reports stopped once, even when onEnded follows", () => {
    const h = createHarness();
    h.speak("a");
    h.stopLine("a");
    expect(h.player.stop).toHaveBeenCalledTimes(1);
    h.plays[0].onEnded();
    h.stopLine("a");
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
  });

  it("a stop for another id does nothing", () => {
    const h = createHarness();
    h.speak("a");
    h.stopLine("other");
    expect(h.player.stop).not.toHaveBeenCalled();
    expect(h.reports).toEqual([]);
    h.plays[0].onEnded();
    expect(h.reports).toEqual([{ lineId: "a", outcome: "ended" }]);
  });

  it("a new line while one plays reports the old one stopped once and plays the new", () => {
    const h = createHarness();
    h.speak("a", [1]);
    h.speak("b", [2]);
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
    expect(h.player.stop).toHaveBeenCalledTimes(1);
    expect(bytesIn(h.plays[1].audio)).toEqual([2]);
    h.plays[0].onEnded();
    h.plays[1].onEnded();
    expect(h.reports).toEqual([
      { lineId: "a", outcome: "stopped" },
      { lineId: "b", outcome: "ended" },
    ]);
  });
});

describe("playback failures", () => {
  it("a decode failure reports failed and logs its name", async () => {
    const h = createHarness();
    h.speak("a");
    h.plays[0].reject(new DOMException("bad audio", "EncodingError"));
    await flush();
    expect(h.reports).toEqual([{ lineId: "a", outcome: "failed" }]);
    expect(console.log).toHaveBeenCalledWith(
      "[Playback] failed: EncodingError",
    );
  });

  it("a play that throws synchronously reports failed", async () => {
    const h = createHarness();
    h.player.play.mockImplementationOnce(() => {
      throw new TypeError("no output");
    });
    h.speak("a");
    await flush();
    expect(h.reports).toEqual([{ lineId: "a", outcome: "failed" }]);
  });

  it("an old line's late rejection after a replacement reports nothing and leaves the new line playing", async () => {
    const h = createHarness();
    h.speak("a");
    h.speak("b");
    h.plays[0].reject(new DOMException("aborted", "AbortError"));
    await flush();
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
    h.plays[1].onEnded();
    expect(h.reports).toEqual([
      { lineId: "a", outcome: "stopped" },
      { lineId: "b", outcome: "ended" },
    ]);
  });
});

describe("playback cleanup", () => {
  it("unsubscribes, stops and disposes, reports nothing, and a later onEnded reports nothing", () => {
    const h = createHarness();
    h.speak("a");
    h.cleanup();
    expect(h.unsubscribeSpeech).toHaveBeenCalledTimes(1);
    expect(h.unsubscribeStop).toHaveBeenCalledTimes(1);
    expect(h.player.stop).toHaveBeenCalledTimes(1);
    expect(h.player.dispose).toHaveBeenCalledTimes(1);
    h.plays[0].onEnded();
    expect(h.reports).toEqual([]);
  });

  it("is safe to call twice", () => {
    const h = createHarness();
    h.cleanup();
    h.cleanup();
    expect(h.unsubscribeSpeech).toHaveBeenCalledTimes(1);
    expect(h.player.dispose).toHaveBeenCalledTimes(1);
  });
});
