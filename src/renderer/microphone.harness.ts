import { vi } from "vitest";
import type { Clip, RecordingCommand } from "../shared/ipc";
import { startMicrophone } from "./microphone";
import type { MicStream, Recorder } from "./microphone";

export const mimeType = "audio/webm;codecs=opus";

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

type Breakage = "create" | "start" | "stop" | "getUserMediaThrows" | null;

export function createHarness(breakage: Breakage = null) {
  const holder: { onCommand?: (command: RecordingCommand) => void } = {};
  const unsubscribe = vi.fn();
  const clips: Clip[] = [];
  const streams: FakeStream[] = [];
  const recorders: ReturnType<typeof createFakeRecorder>[] = [];
  const getUserMedia = vi.fn((): Promise<MicStream> => {
    if (breakage === "getUserMediaThrows") throw new TypeError("no devices");
    return new Promise<MicStream>((resolve, reject) => {
      const stopTrack = vi.fn();
      const stream = { getTracks: () => [{ stop: stopTrack }] };
      streams.push({
        stream,
        stopTrack,
        resolve: () => resolve(stream),
        reject,
      });
    });
  });
  const createRecorder = vi.fn(() => {
    if (breakage === "create") {
      throw new DOMException("no", "NotSupportedError");
    }
    const fake = createFakeRecorder();
    const fail = () => {
      throw new DOMException("bad state", "InvalidStateError");
    };
    if (breakage === "start") fake.recorder.start = vi.fn(fail);
    if (breakage === "stop") fake.recorder.stop = vi.fn(fail);
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

export type Harness = ReturnType<typeof createHarness>;

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function resolveStream(h: Harness, index: number): Promise<void> {
  h.streams[index].resolve();
  await flush();
}

export const zeroByteClip = (utteranceId: string): Clip => ({
  utteranceId,
  outcome: "recorded",
  audio: new ArrayBuffer(0),
  mimeType: "",
});

export const failedError = (utteranceId: string): Clip => ({
  utteranceId,
  outcome: "failed",
  reason: "error",
});
