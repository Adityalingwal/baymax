import { vi } from "vitest";
import type { PlaybackFinished, SpeechLine, StopPlayback } from "../shared/ipc";
import { startPlayback } from "./playback";
import type { AudioOutput, Player } from "./playback";

type PlayCall = {
  audio: ArrayBuffer;
  onEnded: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function createFakePlayer() {
  const plays: PlayCall[] = [];
  const player = {
    play: vi.fn(
      (audio: ArrayBuffer, onEnded: () => void) =>
        new Promise<void>((resolve, reject) => {
          plays.push({ audio, onEnded, resolve, reject });
        }),
    ),
    stop: vi.fn(),
    dispose: vi.fn(),
  } satisfies Player;
  return { player, plays };
}

export function createHarness() {
  const holder: {
    onSpeech?: (line: SpeechLine) => void;
    onStop?: (payload: StopPlayback) => void;
  } = {};
  const reports: PlaybackFinished[] = [];
  const unsubscribeSpeech = vi.fn();
  const unsubscribeStop = vi.fn();
  const { player, plays } = createFakePlayer();
  const bridge = {
    onSpeech: (callback: (line: SpeechLine) => void) => {
      holder.onSpeech = callback;
      return unsubscribeSpeech;
    },
    onStopPlayback: (callback: (payload: StopPlayback) => void) => {
      holder.onStop = callback;
      return unsubscribeStop;
    },
    reportPlaybackFinished: vi.fn((payload: PlaybackFinished) => {
      reports.push(payload);
    }),
  };
  const cleanup = startPlayback(bridge, player);
  const speak = (lineId: string, bytes = [1]) =>
    holder.onSpeech?.({
      lineId,
      audio: bytesOf(bytes),
      mimeType: "audio/mpeg",
    });
  const stopLine = (lineId: string) => holder.onStop?.({ lineId });
  return {
    speak,
    stopLine,
    cleanup,
    reports,
    plays,
    player,
    bridge,
    unsubscribeSpeech,
    unsubscribeStop,
  };
}

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function bytesOf(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

export function bytesIn(audio: ArrayBuffer): number[] {
  return [...new Uint8Array(audio)];
}

type Deferred<T> = {
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
};

// Set by a test to make the next source's start or stop throw.
type Faults = { start: boolean; stop: boolean };

function failIf(fault: boolean, what: string): void {
  if (fault) throw new DOMException(`${what} failed`, "InvalidStateError");
}

function createStubSource(faults: Faults) {
  const slots: {
    buffer: object | null;
    onended: ((event: Event) => void) | null;
  } = { buffer: null, onended: null };
  return Object.assign(slots, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(() => failIf(faults.start, "start")),
    stop: vi.fn(() => failIf(faults.stop, "stop")),
  });
}

// A stubbed AudioContext slice whose decode and resume the test settles.
export function createStubOutput(state: "running" | "suspended") {
  const decodes: (Deferred<object> & { audio: ArrayBuffer })[] = [];
  const resumes: Deferred<void>[] = [];
  const sources: ReturnType<typeof createStubSource>[] = [];
  const faults: Faults = { start: false, stop: false };
  const output = {
    state,
    destination: { node: "destination" },
    decodeAudioData: vi.fn(
      (audio: ArrayBuffer) =>
        new Promise<object>((resolve, reject) => {
          decodes.push({ audio, resolve, reject });
        }),
    ),
    createBufferSource: vi.fn(() => {
      const source = createStubSource(faults);
      sources.push(source);
      return source;
    }),
    resume: vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          resumes.push({ resolve, reject });
        }),
    ),
    close: vi.fn(() => Promise.resolve()),
  } satisfies AudioOutput;
  const createOutput = vi.fn(() => output);
  return { output, createOutput, decodes, resumes, sources, faults };
}
