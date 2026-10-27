import { vi } from "vitest";
import type { DeepgramFailure, Synthesis } from "../providers/deepgram";
import type { TaskId } from "../shared/cards";
import type { LineId, SpeechLine, StopPlayback } from "../shared/ipc";
import { createSpeech } from "./speech";
import type { VoiceDownCause } from "./speech";
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

export function createHarness() {
  const calls: Call[] = [];
  const speeches: SpeechLine[] = [];
  const stops: StopPlayback[] = [];
  const voice: { available: boolean; cause: VoiceDownCause | null }[] = [];
  const { timers, setTimer } = createFakeTimers();
  const synthesize = vi.fn(
    (text: string, signal: AbortSignal) =>
      new Promise<Synthesis>((resolve, reject) => {
        calls.push({ text, signal, resolve, reject });
      }),
  );
  const sendSpeech = vi.fn((line: SpeechLine) => {
    speeches.push(line);
  });
  const sendStop = vi.fn((payload: StopPlayback) => {
    stops.push(payload);
  });
  const onVoiceAvailable = vi.fn(
    (available: boolean, cause: VoiceDownCause | null) => {
      voice.push({ available, cause });
    },
  );
  const speech = createSpeech({
    synthesize,
    sendSpeech,
    sendStop,
    onVoiceAvailable,
    timers: { setTimer },
  });
  const texts = () => calls.map((call) => call.text);
  return {
    speech,
    calls,
    texts,
    speeches,
    stops,
    voice,
    timers,
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
