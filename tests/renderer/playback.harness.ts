import { vi } from "vitest";
import type {
  PlaybackFinished,
  SpeechChunk,
  SpeechEnd,
  SpeechLine,
  StopPlayback,
} from "../../src/shared/ipc";
import { startPlayback } from "../../src/renderer/playback";
import type { AudioOutput, Player } from "../../src/renderer/web-audio";

type PlayCall = {
  audio: ArrayBuffer;
  onEnded: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function createFakePlayer() {
  const plays: PlayCall[] = [];
  // Each queued chunk by its first byte; drained fires the callback the line waits on.
  const queued: number[] = [];
  const waiting: { onDrained: (() => void) | null } = { onDrained: null };
  const player = {
    play: vi.fn(
      (audio: ArrayBuffer, onEnded: () => void) =>
        new Promise<void>((resolve, reject) => {
          plays.push({ audio, onEnded, resolve, reject });
        }),
    ),
    queue: vi.fn((pcm: ArrayBuffer) => {
      queued.push(new Uint8Array(pcm)[0]);
    }),
    whenDrained: vi.fn((onDrained: () => void) => {
      waiting.onDrained = onDrained;
    }),
    stop: vi.fn(),
    dispose: vi.fn(),
  } satisfies Player;
  const drain = () => waiting.onDrained?.();
  return { player, plays, queued, drain };
}

type Holder = {
  onSpeech?: (line: SpeechLine) => void;
  onChunk?: (chunk: SpeechChunk) => void;
  onEnd?: (end: SpeechEnd) => void;
  onStop?: (payload: StopPlayback) => void;
};

// The bridge's callbacks land in the holder, so a test can play main's side.
function createFakeBridge(holder: Holder, reports: PlaybackFinished[]) {
  const unsubscribeSpeech = vi.fn();
  const unsubscribeStop = vi.fn();
  const bridge = {
    onSpeech: (callback: (line: SpeechLine) => void) => {
      holder.onSpeech = callback;
      return unsubscribeSpeech;
    },
    onSpeechChunk: (callback: (chunk: SpeechChunk) => void) => {
      holder.onChunk = callback;
      return vi.fn();
    },
    onSpeechEnd: (callback: (end: SpeechEnd) => void) => {
      holder.onEnd = callback;
      return vi.fn();
    },
    onStopPlayback: (callback: (payload: StopPlayback) => void) => {
      holder.onStop = callback;
      return unsubscribeStop;
    },
    reportPlaybackFinished: vi.fn((payload: PlaybackFinished) => {
      reports.push(payload);
    }),
  };
  return { bridge, unsubscribeSpeech, unsubscribeStop };
}

// With a real player the test drives it through its output; otherwise the fake player records what it was told.
export function createHarness(realPlayer?: Player) {
  const holder: Holder = {};
  const reports: PlaybackFinished[] = [];
  const { player, plays, queued, drain } = createFakePlayer();
  const fake = createFakeBridge(holder, reports);
  const { bridge, unsubscribeSpeech, unsubscribeStop } = fake;
  const cleanup = startPlayback(bridge, realPlayer ?? player);
  const speak = (lineId: string, bytes = [1]) =>
    holder.onSpeech?.({
      lineId,
      audio: bytesOf(bytes),
      mimeType: "audio/mpeg",
    });
  const stopLine = (lineId: string) => holder.onStop?.({ lineId });
  const chunk = (lineId: string, seq: number, mark = seq + 1) =>
    holder.onChunk?.({
      lineId,
      seq,
      pcm: bytesOf([mark, 0x40]),
      sampleRate: 24_000,
    });
  const end = (lineId: string) => holder.onEnd?.({ lineId });
  return {
    speak,
    stopLine,
    chunk,
    end,
    queued,
    drain,
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
  const buffers: Float32Array[] = [];
  const output = {
    state,
    destination: { node: "destination" },
    currentTime: 0,
    createBuffer: vi.fn((_channels: number, length: number) => {
      const samples = new Float32Array(length);
      buffers.push(samples);
      return { getChannelData: () => samples };
    }),
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
  return { output, createOutput, decodes, resumes, sources, faults, buffers };
}
