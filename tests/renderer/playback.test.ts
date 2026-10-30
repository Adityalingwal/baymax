import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebAudioPlayer } from "../../src/renderer/web-audio";
import {
  bytesIn,
  createHarness,
  createStubOutput,
  flush,
} from "./playback.harness";

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

describe("a throwing player or bridge never leaves a line half-finished", () => {
  it("an onEnded fired inside stop reports stopped once and leaves the new line alone", () => {
    const h = createHarness();
    h.speak("a");
    h.player.stop.mockImplementationOnce(() => h.plays[0].onEnded());
    h.speak("b");
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
    h.plays[1].onEnded();
    expect(h.reports).toEqual([
      { lineId: "a", outcome: "stopped" },
      { lineId: "b", outcome: "ended" },
    ]);
  });

  it("a throwing stop still reports stopped and plays the new line", () => {
    const h = createHarness();
    h.speak("a");
    h.player.stop.mockImplementationOnce(() => {
      throw new Error("already stopped");
    });
    h.speak("b");
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
    expect(h.plays).toHaveLength(2);
  });

  it("a throwing report is logged and the next line still reports", async () => {
    const h = createHarness();
    h.bridge.reportPlaybackFinished.mockImplementationOnce(() => {
      throw new Error("bridge gone");
    });
    h.speak("a");
    h.plays[0].reject(new DOMException("bad audio", "EncodingError"));
    await flush();
    h.speak("b");
    h.plays[1].onEnded();
    expect(h.reports).toEqual([{ lineId: "b", outcome: "ended" }]);
    expect(console.log).toHaveBeenCalledWith(
      "[Playback] reporting failed: Error",
    );
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

  it("cleanup still disposes when stop throws", () => {
    const h = createHarness();
    h.speak("a");
    h.player.stop.mockImplementationOnce(() => {
      throw new Error("already stopped");
    });
    h.cleanup();
    expect(h.player.dispose).toHaveBeenCalledTimes(1);
  });

  it("is safe to call twice", () => {
    const h = createHarness();
    h.cleanup();
    h.cleanup();
    expect(h.unsubscribeSpeech).toHaveBeenCalledTimes(1);
    expect(h.player.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("a streamed line (L10b)", () => {
  it("queues its chunks in seq order and reports ended once, after its end and the last chunk played", () => {
    const h = createHarness();
    h.chunk("a", 0);
    h.chunk("a", 1);
    expect(h.queued).toEqual([1, 2]);
    h.drain();
    expect(h.reports).toEqual([]);
    h.end("a");
    expect(h.reports).toEqual([]);
    h.drain();
    h.drain();
    expect(h.reports).toEqual([{ lineId: "a", outcome: "ended" }]);
  });

  it("ignores a chunk out of seq order, and a new line that does not start at seq 0", () => {
    const h = createHarness();
    h.chunk("a", 1);
    h.chunk("a", 0);
    h.chunk("a", 2);
    h.chunk("a", 1);
    expect(h.queued).toEqual([1, 2]);
  });

  it("reports a line with no audio ended at its end", () => {
    const h = createHarness();
    h.end("a");
    h.end("a");
    expect(h.reports).toEqual([{ lineId: "a", outcome: "ended" }]);
  });
});

describe("a streamed line on the real player", () => {
  it("that ends before its start buffer runs out plays it and reports ended once", () => {
    const stub = createStubOutput("running");
    const h = createHarness(createWebAudioPlayer(stub.createOutput));
    h.chunk("a", 0);
    h.end("a");
    expect(h.reports).toEqual([]);
    stub.sources[0].onended?.(new Event("ended"));
    stub.sources[0].onended?.(new Event("ended"));
    expect(h.reports).toEqual([{ lineId: "a", outcome: "ended" }]);
  });

  it("stopped during its start buffer never plays, and reports stopped once", () => {
    const stub = createStubOutput("running");
    const h = createHarness(createWebAudioPlayer(stub.createOutput));
    h.chunk("a", 0);
    h.stopLine("a");
    h.chunk("a", 1);
    expect(stub.sources).toHaveLength(1);
    expect(stub.sources[0].stop).toHaveBeenCalledTimes(1);
    expect(stub.sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
  });
});

describe("stopping a streamed line (L10b)", () => {
  it("a stop stops the player, reports stopped once and ignores the line's later chunks and end", () => {
    const h = createHarness();
    h.chunk("a", 0);
    h.stopLine("a");
    h.chunk("a", 1);
    h.end("a");
    h.drain();
    expect(h.player.stop).toHaveBeenCalledTimes(1);
    expect(h.queued).toEqual([1]);
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
  });

  it("ignores the chunks of a line told to stop before its audio came", () => {
    const h = createHarness();
    h.stopLine("a");
    h.chunk("a", 0);
    expect(h.queued).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("a whole clip while a line streams stops the stream first", () => {
    const h = createHarness();
    h.chunk("a", 0);
    h.speak("b");
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
    expect(h.plays).toHaveLength(1);
  });
});
