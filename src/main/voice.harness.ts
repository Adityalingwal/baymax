import type { Synthesis, Transcription } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import type { WaitingQuestion } from "../shared/engine";
import type { RecordingCommand, SpeechLine, StopPlayback } from "../shared/ipc";
import type { HoldOutcome } from "./hold";
import { createClock } from "./tasks/harness";
import type { VoiceState } from "./voice";
import { createVoice } from "./voice";

type Deferred<T> = { text: string; resolve: (result: T) => void };

export type Asked = {
  words: string;
  utteranceId: UtteranceId | null;
  waiting: WaitingQuestion | null;
};

// Records every state call in order, so a test sees what voice asked of main.
function fakeState() {
  const calls: string[] = [];
  const asked: Asked[] = [];
  const control = { waiting: null as WaitingQuestion | null };
  const state: VoiceState = {
    ask: (words, utteranceId, waiting) => {
      asked.push({ words, utteranceId, waiting });
      calls.push(`ask ${words}`);
    },
    waitingQuestion: () => control.waiting,
    setMuted: (muted) => calls.push(`muted ${String(muted)}`),
    setVoiceAvailable: (available) =>
      calls.push(`voiceAvailable ${String(available)}`),
    showNotice: (notice) => calls.push(`notice ${notice}`),
  };
  return { state, calls, asked, control };
}

type Options = { deepgramKeyPresent?: boolean; started?: boolean };

export function createHarness(options: Options = {}) {
  const fake = fakeState();
  const clock = createClock();
  const seen = {
    recordings: [] as RecordingCommand[],
    speeches: [] as SpeechLine[],
    stops: [] as StopPlayback[],
    logs: [] as string[],
    timeline: [] as string[],
    transcriptions: [] as Deferred<Transcription>[],
    syntheses: [] as Deferred<Synthesis>[],
  };
  const control = { now: 0, recordingFails: false };
  const voice = createVoice({
    sendRecording: (command) => {
      seen.timeline.push(`recording ${command.type}`);
      if (control.recordingFails) throw new Error("window gone");
      seen.recordings.push(command);
    },
    sendSpeech: (line) => seen.speeches.push(line),
    sendStop: (payload) => {
      seen.timeline.push("stop playback");
      seen.stops.push(payload);
    },
    transcribe: () =>
      new Promise((resolve) => seen.transcriptions.push({ text: "", resolve })),
    synthesize: (text) =>
      new Promise((resolve) => seen.syntheses.push({ text, resolve })),
    timers: { setTimer: clock.setTimer },
    now: () => control.now,
    log: (message) => seen.logs.push(message),
    deepgramKeyPresent: options.deepgramKeyPresent ?? true,
  });
  if (options.started ?? true) voice.start(fake.state);
  return { ...seen, ...fake, voice, waiting: fake.control, control };
}

export type Harness = ReturnType<typeof createHarness>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// One hold: key down, then key up with the outcome; returns the minted utterance id.
export function hold(h: Harness, outcome: HoldOutcome = "accept"): UtteranceId {
  h.voice.holdChanged("listening", null);
  const start = h.recordings.filter((command) => command.type === "start");
  const utteranceId = start[start.length - 1].utteranceId;
  h.voice.holdChanged("idle", outcome);
  return utteranceId;
}

export function sendClip(h: Harness, utteranceId: UtteranceId): void {
  h.voice.clipArrived({
    utteranceId,
    outcome: "recorded",
    audio: new ArrayBuffer(4),
    mimeType: "audio/webm",
  });
}

export async function transcribed(
  h: Harness,
  index: number,
  result: Transcription,
): Promise<void> {
  h.transcriptions[index].resolve(result);
  await flush();
}

export async function synthesized(
  h: Harness,
  index: number,
  result: Synthesis,
): Promise<void> {
  h.syntheses[index].resolve(result);
  await flush();
}

export const audio: Synthesis = {
  kind: "audio",
  audio: new Uint8Array([1]).buffer,
  mimeType: "audio/mpeg",
};

export function failed(cause: "unreachable" | "keyRejected" | "noCredit") {
  return { kind: "failed", cause, detail: `${cause} detail` } as const;
}

export function waitingQuestion(questionId: string): WaitingQuestion {
  return {
    taskId: "t1",
    question: { questionId, text: `${questionId}?`, choices: ["a", "b"] },
  };
}
