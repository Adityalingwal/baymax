import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, RecordingCommand } from "../shared/ipc";
import { startMicrophone } from "./microphone";
import type { MicStream, Recorder } from "./microphone";

const mimeType = "audio/webm;codecs=opus";

function createFakeRecorder() {
  const chunkListeners: ((chunk: Blob) => void)[] = [];
  const startListeners: (() => void)[] = [];
  const stopListeners: (() => void)[] = [];
  const errorListeners: (() => void)[] = [];
  const recorder: Recorder = {
    mimeType,
    start: vi.fn(),
    stop: vi.fn(),
    onChunk: (listener) => chunkListeners.push(listener),
    onStart: (listener) => startListeners.push(listener),
    onStop: (listener) => stopListeners.push(listener),
    onError: (listener) => errorListeners.push(listener),
  };
  return {
    recorder,
    emitChunk: (chunk: Blob) => chunkListeners.forEach((l) => l(chunk)),
    emitStart: () => startListeners.forEach((l) => l()),
    emitStop: () => stopListeners.forEach((l) => l()),
    emitError: () => errorListeners.forEach((l) => l()),
  };
}

type FakeStream = {
  stream: MicStream;
  stopTrack: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function createHarness(createRecorderThrows = false) {
  const holder: { onCommand?: (command: RecordingCommand) => void } = {};
  const unsubscribe = vi.fn();
  const clips: Clip[] = [];
  const streams: FakeStream[] = [];
  const recorders: ReturnType<typeof createFakeRecorder>[] = [];
  const getUserMedia = vi.fn(
    () =>
      new Promise<MicStream>((resolve, reject) => {
        const stopTrack = vi.fn();
        const stream = { getTracks: () => [{ stop: stopTrack }] };
        streams.push({
          stream,
          stopTrack,
          resolve: () => resolve(stream),
          reject,
        });
      }),
  );
  const createRecorder = vi.fn(() => {
    if (createRecorderThrows) throw new DOMException("no", "NotSupportedError");
    const fake = createFakeRecorder();
    recorders.push(fake);
    return fake.recorder;
  });
  const bridge = {
    onRecording: (callback: (command: RecordingCommand) => void) => {
      holder.onCommand = callback;
      return unsubscribe;
    },
    sendClip: (clip: Clip) => clips.push(clip),
  };
  const cleanup = startMicrophone(bridge, {
    getUserMedia,
    createRecorder,
    now: () => 0,
  });
  const start = (utteranceId: string) =>
    holder.onCommand?.({ type: "start", utteranceId });
  const stop = (utteranceId: string) =>
    holder.onCommand?.({ type: "stop", utteranceId });
  return { start, stop, cleanup, unsubscribe, clips, streams, recorders };
}

type Harness = ReturnType<typeof createHarness>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function resolveStream(h: Harness, index: number): Promise<void> {
  h.streams[index].resolve();
  await flush();
}

const zeroByteClip = (utteranceId: string): Clip => ({
  utteranceId,
  outcome: "recorded",
  audio: new ArrayBuffer(0),
  mimeType: "",
});

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
    fake.emitChunk(new Blob([new Uint8Array([4, 5])]));
    h.stop("a");
    expect(fake.recorder.stop).toHaveBeenCalledTimes(1);
    expect(h.clips).toEqual([]);
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

type FailureRow = { name: string; error: string; reason: string };

const failureRows: FailureRow[] = [
  {
    name: "NotAllowedError",
    error: "NotAllowedError",
    reason: "permissionDenied",
  },
  { name: "SecurityError", error: "SecurityError", reason: "permissionDenied" },
  { name: "NotFoundError", error: "NotFoundError", reason: "noMicrophone" },
  {
    name: "OverconstrainedError",
    error: "OverconstrainedError",
    reason: "noMicrophone",
  },
  { name: "AbortError", error: "AbortError", reason: "error" },
];

describe("microphone stream failures", () => {
  it.each(failureRows)(
    "getUserMedia rejecting with $name sends failed $reason, only after the stop",
    async ({ error, reason }) => {
      const h = createHarness();
      h.start("a");
      h.streams[0].reject(new DOMException("denied", error));
      await flush();
      expect(h.clips).toEqual([]);
      h.stop("a");
      expect(h.clips).toEqual([
        { utteranceId: "a", outcome: "failed", reason },
      ]);
    },
  );
});

describe("microphone recorder failures", () => {
  it("createRecorder throwing sends a failed error clip after the stop and stops the tracks", async () => {
    const h = createHarness(true);
    h.start("a");
    await resolveStream(h, 0);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.clips).toEqual([]);
    h.stop("a");
    expect(h.clips).toEqual([
      { utteranceId: "a", outcome: "failed", reason: "error" },
    ]);
  });

  it("the recorder's error sends a failed error clip after the stop, once", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.recorders[0].emitError();
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.clips).toEqual([]);
    h.stop("a");
    h.recorders[0].emitStop();
    await flush();
    expect(h.clips).toEqual([
      { utteranceId: "a", outcome: "failed", reason: "error" },
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
