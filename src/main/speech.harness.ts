import { vi } from "vitest";
import type { Aura, AuraListener } from "../providers/aura";
import type { DeepgramFailure, Synthesis } from "../providers/deepgram";
import type { TaskId } from "../shared/cards";
import type {
  LineId,
  SpeechChunk,
  SpeechEnd,
  SpeechLine,
  StopPlayback,
} from "../shared/ipc";
import { createSpeech } from "./speech";
import type { VoiceDownCause } from "./speech-model";
import type { SaidKind, SaidLine } from "./tasks/state";

type Call = {
  text: string;
  signal: AbortSignal;
  resolve: (result: Synthesis) => void;
  reject: (error: unknown) => void;
};

type FakeTimer = { ms: number; fire: () => void; cancelled: boolean };

function createFakeTimers() {
  const timers: FakeTimer[] = [];
  const setTimer = (ms: number, fire: () => void) => {
    const timer: FakeTimer = { ms, fire, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return { timers, setTimer };
}

// An Aura socket the test opens, closes and answers; it records what speech sent on it in order.
export function createFakeAura() {
  const control = { open: false, listener: null as AuraListener | null };
  const sent: string[] = [];
  const record = (entry: string) => {
    if (!control.open) return false;
    sent.push(entry);
    return true;
  };
  const aura: Aura = {
    isOpen: () => control.open,
    speak: (text) => record(`speak ${text}`),
    flush: () => record("flush"),
    clear: () => record("clear"),
    stop: () => undefined,
  };
  const listener = () => {
    if (control.listener === null) throw new Error("Aura was not started");
    return control.listener;
  };
  return {
    sent,
    startAura: (started: AuraListener) => {
      control.listener = started;
      return aura;
    },
    open: () => {
      control.open = true;
    },
    close: () => {
      control.open = false;
      listener().closed();
    },
    audio: (mark: number) =>
      listener().heard({ kind: "audio", pcm: new Uint8Array([mark]).buffer }),
    flushed: () => listener().heard({ kind: "flushed" }),
  };
}

export type FakeAura = ReturnType<typeof createFakeAura>;

// Each call waits until a test settles it.
function fakeSynthesize(calls: Call[]) {
  return vi.fn(
    (text: string, signal: AbortSignal) =>
      new Promise<Synthesis>((resolve, reject) => {
        calls.push({ text, signal, resolve, reject });
      }),
  );
}

// Without a fake Aura there is no socket, so every line goes to the REST call.
export function createHarness(fakeAura: FakeAura | null = null) {
  const calls: Call[] = [];
  const speeches: SpeechLine[] = [];
  const chunks: SpeechChunk[] = [];
  const ends: SpeechEnd[] = [];
  const stops: StopPlayback[] = [];
  const voice: { available: boolean; cause: VoiceDownCause | null }[] = [];
  const fakeTimers = createFakeTimers();
  const timers = fakeTimers.timers;
  const setTimer = vi.fn(fakeTimers.setTimer);
  const synthesize = fakeSynthesize(calls);
  const sendSpeech = vi.fn((line: SpeechLine): void => {
    speeches.push(line);
  });
  const sendStop = vi.fn((payload: StopPlayback): void => {
    stops.push(payload);
  });
  const onVoiceAvailable = vi.fn(
    (available: boolean, cause: VoiceDownCause | null): void => {
      voice.push({ available, cause });
    },
  );
  const speech = createSpeech({
    synthesize,
    startAura: (listener) => fakeAura?.startAura(listener) ?? null,
    sendSpeech,
    sendChunk: (chunk) => chunks.push(chunk),
    sendEnd: (end) => ends.push(end),
    sendStop,
    onVoiceAvailable,
    timers: { setTimer },
  });
  return {
    speech,
    texts: () => calls.map((call) => call.text),
    calls,
    speeches,
    chunks,
    ends,
    stops,
    voice,
    timers,
    setTimer,
    synthesize,
    sendSpeech,
    sendStop,
    onVoiceAvailable,
  };
}

export type Harness = ReturnType<typeof createHarness>;

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function said(
  text: string,
  taskId: TaskId | null = "t1",
  kind: SaidKind = "answer",
): SaidLine {
  return { taskId, text, kind };
}

export function audio(byte = 1): Synthesis {
  return {
    kind: "audio",
    audio: new Uint8Array([byte]).buffer,
    mimeType: "audio/mpeg",
  };
}

export function failure(cause: DeepgramFailure): Synthesis {
  return { kind: "failed", cause, detail: `${cause} detail` };
}

export async function resolveCall(
  h: Harness,
  index: number,
  result: Synthesis = audio(),
): Promise<void> {
  h.calls[index].resolve(result);
  await flush();
}

function lastLineId(h: Harness): LineId {
  return h.speeches[h.speeches.length - 1].lineId;
}

// Says a line, lets its synthesis succeed and returns the id it was sent with.
export async function play(h: Harness, line: SaidLine): Promise<LineId> {
  h.speech.speak(line);
  await resolveCall(h, h.calls.length - 1);
  return lastLineId(h);
}

export function finish(h: Harness, lineId: LineId): void {
  h.speech.playbackFinished({ lineId, outcome: "ended" });
}
