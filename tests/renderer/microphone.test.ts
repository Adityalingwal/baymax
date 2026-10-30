import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturing,
  createHarness,
  flush,
  resolveCapture,
  resolveStream,
} from "./microphone.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("microphone streams one utterance's frames", () => {
  it("sends frames as they come, then the last frames and the end after the stop", async () => {
    const h = createHarness();
    h.start("a");
    await capturing(h, 0);
    const capture = h.captures[0];
    capture.frame(1);
    capture.frame(2);
    h.stop("a");
    expect(capture.flush).toHaveBeenCalledTimes(1);
    capture.frame(3);
    expect(h.seen()).toEqual(["a frame 1", "a frame 2", "a frame 3"]);
    capture.answerFlush();
    await flush();
    expect(h.seen()).toEqual(["a frame 1", "a frame 2", "a frame 3", "a end"]);
    expect(capture.close).toHaveBeenCalledTimes(1);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    capture.frame(4);
    expect(h.seen()).toHaveLength(4);
  });

  it("a stop for another id does nothing", async () => {
    const h = createHarness();
    h.start("a");
    await capturing(h, 0);
    h.stop("other");
    expect(h.captures[0].flush).not.toHaveBeenCalled();
    expect(h.seen()).toEqual([]);
  });

  it("still ends when the flush fails", async () => {
    const h = createHarness("flushRejects");
    h.start("a");
    await capturing(h, 0);
    h.stop("a");
    await flush();
    expect(h.seen()).toEqual(["a end"]);
  });
});

describe("microphone stream races", () => {
  it("a stop before the stream resolves sends only the end, stops the tracks and starts no capture", async () => {
    const h = createHarness();
    h.start("a");
    h.stop("a");
    expect(h.seen()).toEqual([]);
    await resolveStream(h, 0);
    expect(h.seen()).toEqual(["a end"]);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.captures).toHaveLength(0);
  });

  it("a stop before the capture is ready ends the capture once it is", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.stop("a");
    await resolveCapture(h, 0);
    expect(h.captures[0].flush).toHaveBeenCalledTimes(1);
    h.captures[0].answerFlush();
    await flush();
    expect(h.seen()).toEqual(["a end"]);
  });
});

describe("microphone holds that overlap", () => {
  it("start A, stop A with its stream pending, start B: A ends empty, B streams normally", async () => {
    const h = createHarness();
    h.start("a");
    h.stop("a");
    h.start("b");
    expect(h.streams).toHaveLength(2);
    await resolveStream(h, 0);
    expect(h.streams[1].stopTrack).not.toHaveBeenCalled();
    await resolveStream(h, 1);
    await resolveCapture(h, 0);
    h.captures[0].frame(7);
    h.stop("b");
    h.captures[0].answerFlush();
    await flush();
    expect(h.seen()).toEqual(["a end", "b frame 7", "b end"]);
  });

  it("a second start while capturing ends the first and asks for a new stream at once", async () => {
    const h = createHarness();
    h.start("a");
    await capturing(h, 0);
    h.start("b");
    expect(h.streams).toHaveLength(2);
    expect(h.captures[0].flush).toHaveBeenCalledTimes(1);
    h.captures[0].answerFlush();
    await flush();
    expect(h.seen()).toEqual(["a end"]);
  });
});

describe("microphone cleanup", () => {
  it("unsubscribes, closes a live capture and its tracks, and sends nothing after", async () => {
    const h = createHarness();
    h.start("a");
    await capturing(h, 0);
    h.cleanup();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.captures[0].close).toHaveBeenCalledTimes(1);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    h.captures[0].frame(1);
    h.stop("a");
    await flush();
    expect(h.seen()).toEqual([]);
  });

  it("stops the tracks of a stream that resolves after cleanup and sends nothing", async () => {
    const h = createHarness();
    h.start("a");
    h.stop("a");
    h.cleanup();
    await resolveStream(h, 0);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.captures).toHaveLength(0);
    expect(h.seen()).toEqual([]);
  });
});
