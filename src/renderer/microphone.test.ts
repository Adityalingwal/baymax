import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  flush,
  mimeType,
  resolveStream,
  zeroByteClip,
} from "./microphone.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("microphone records one clip per utterance", () => {
  it("start -> stop sends one recorded clip with the chunks' bytes and stops the tracks", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    const fake = h.recorders[0];
    expect(fake.recorder.start).toHaveBeenCalledTimes(1);
    fake.emitStart();
    fake.emitChunk(new Blob([new Uint8Array([1, 2, 3])]));
    h.stop("a");
    expect(fake.recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.clips).toEqual([]);
    // MediaRecorder hands over the last chunk after stop() and before its stop event.
    fake.emitChunk(new Blob([new Uint8Array([4, 5])]));
    fake.emitStop();
    await flush();
    expect(h.clips).toHaveLength(1);
    const clip = h.clips[0];
    expect(clip).toMatchObject({
      utteranceId: "a",
      outcome: "recorded",
      mimeType,
    });
    if (clip.outcome !== "recorded")
      throw new Error("expected a recorded clip");
    expect([...new Uint8Array(clip.audio)]).toEqual([1, 2, 3, 4, 5]);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
  });

  it("a stop for another id does nothing", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.stop("other");
    await flush();
    expect(h.recorders[0].recorder.stop).not.toHaveBeenCalled();
    expect(h.clips).toEqual([]);
  });
});

describe("microphone stream races", () => {
  it("a stop before the stream resolves sends a zero-byte clip, stops the tracks, creates no recorder", async () => {
    const h = createHarness();
    h.start("a");
    h.stop("a");
    expect(h.clips).toEqual([]);
    await resolveStream(h, 0);
    expect(h.clips).toEqual([zeroByteClip("a")]);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.recorders).toHaveLength(0);
  });

  it("start A, stop A with its stream pending, start B: A's zero-byte clip, B records normally", async () => {
    const h = createHarness();
    h.start("a");
    h.stop("a");
    h.start("b");
    expect(h.streams).toHaveLength(2);
    await resolveStream(h, 0);
    expect(h.clips).toEqual([zeroByteClip("a")]);
    expect(h.streams[1].stopTrack).not.toHaveBeenCalled();
    await resolveStream(h, 1);
    h.recorders[0].emitChunk(new Blob([new Uint8Array([7])]));
    h.stop("b");
    h.recorders[0].emitStop();
    await flush();
    expect(h.clips).toHaveLength(2);
    expect(h.clips[1]).toMatchObject({ utteranceId: "b", outcome: "recorded" });
    expect(h.streams[1].stopTrack).toHaveBeenCalled();
  });

  it("a second start while recording requests its stream at once and sends the first clip when its recorder stops", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.start("b");
    expect(h.streams).toHaveLength(2);
    expect(h.recorders[0].recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.clips).toEqual([]);
    h.recorders[0].emitStop();
    await flush();
    expect(h.clips).toEqual([
      expect.objectContaining({ utteranceId: "a", outcome: "recorded" }),
    ]);
  });
});

describe("microphone cleanup", () => {
  it("unsubscribes, stops a live recording and its tracks, and sends no clip after", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.cleanup();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.recorders[0].recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    h.recorders[0].emitStop();
    await flush();
    expect(h.clips).toEqual([]);
  });

  it("stops the tracks of a stream that resolves after cleanup and sends nothing", async () => {
    const h = createHarness();
    h.start("a");
    h.stop("a");
    h.cleanup();
    await resolveStream(h, 0);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.recorders).toHaveLength(0);
    expect(h.clips).toEqual([]);
  });
});
