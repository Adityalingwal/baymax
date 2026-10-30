import { vi } from "vitest";
import type { MicAudio, RecordingCommand } from "../../src/shared/ipc";
import type { Capture, MicStream } from "../../src/renderer/capture";
import { startMicrophone } from "../../src/renderer/microphone";

type FakeStream = {
  stream: MicStream;
  stopTrack: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

// One capture the test drives: it posts frames, and its flush waits until the test answers it.
type FakeCapture = {
  frame: (mark: number) => void;
  answerFlush: () => void;
  flush: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type Breakage = "getUserMediaThrows" | "flushRejects" | null;

function fakeStream(streams: FakeStream[]) {
  return new Promise<MicStream>((resolve, reject) => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] };
    streams.push({ stream, stopTrack, resolve: () => resolve(stream), reject });
  });
}

function fakeCapture(
  captures: FakeCapture[],
  onFrame: (pcm: ArrayBuffer) => void,
  breakage: Breakage,
): Promise<Capture> {
  return new Promise<Capture>((resolve, reject) => {
    let answer = (): void => undefined;
    const flush = vi.fn(() =>
      breakage === "flushRejects"
        ? Promise.reject(new Error("worklet gone"))
        : new Promise<void>((done) => {
            answer = done;
          }),
    );
    const close = vi.fn();
    captures.push({
      frame: (mark) => onFrame(new Uint8Array([mark, 0]).buffer),
      answerFlush: () => answer(),
      flush,
      close,
      resolve: () => resolve({ flush, close }),
      reject,
    });
  });
}

export function createHarness(breakage: Breakage = null) {
  const holder: { onCommand?: (command: RecordingCommand) => void } = {};
  const unsubscribe = vi.fn();
  const sent: MicAudio[] = [];
  const streams: FakeStream[] = [];
  const captures: FakeCapture[] = [];
  const getUserMedia = vi.fn((): Promise<MicStream> => {
    if (breakage === "getUserMediaThrows") throw new TypeError("no devices");
    return fakeStream(streams);
  });
  const startCapture = vi.fn(
    (_stream: MicStream, onFrame: (pcm: ArrayBuffer) => void) =>
      fakeCapture(captures, onFrame, breakage),
  );
  const bridge = {
    onRecording: (callback: (command: RecordingCommand) => void) => {
      holder.onCommand = callback;
      return unsubscribe;
    },
    sendMicAudio: (audio: MicAudio) => sent.push(audio),
  };
  const cleanup = startMicrophone(bridge, {
    getUserMedia,
    startCapture,
    now: () => 0,
  });
  const start = (utteranceId: string) =>
    holder.onCommand?.({ type: "start", utteranceId });
  const stop = (utteranceId: string) =>
    holder.onCommand?.({ type: "stop", utteranceId });
  // What reached main, with a frame shown by its first byte.
  const seen = () =>
    sent.map((audio) =>
      audio.type === "frames"
        ? `${audio.utteranceId} frame ${new Uint8Array(audio.pcm)[0]}`
        : audio.type === "end"
          ? `${audio.utteranceId} end`
          : `${audio.utteranceId} failed ${audio.reason}`,
    );
  return { start, stop, cleanup, unsubscribe, seen, streams, captures };
}

export type Harness = ReturnType<typeof createHarness>;

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function resolveStream(h: Harness, index: number): Promise<void> {
  h.streams[index].resolve();
  await flush();
}

export async function resolveCapture(h: Harness, index: number) {
  h.captures[index].resolve();
  await flush();
}

// The stream and the capture both ready, so frames flow.
export async function capturing(h: Harness, index: number): Promise<void> {
  await resolveStream(h, index);
  await resolveCapture(h, index);
}
