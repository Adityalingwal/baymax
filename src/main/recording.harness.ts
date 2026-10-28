import { vi } from "vitest";
import type { Transcription } from "../providers/deepgram";
import type { Flux, FluxEvent, FluxListener } from "../providers/flux";
import type { UtteranceId } from "../shared/cards";
import type { MicFailure, RecordingCommand } from "../shared/ipc";
import type { HoldOutcome } from "./hold";
import { createRecording } from "./recording";
import type { Heard, NotCaughtCause } from "./recording";
import { createClock } from "./tasks/harness";

type Deferred = {
  audio: ArrayBuffer;
  mimeType: string;
  resolve: (result: Transcription) => void;
  reject: (error: unknown) => void;
};

// A Flux socket the test opens, closes and speaks for; it records what main sent in order.
export function createFakeFlux() {
  const control = { open: false, listener: null as FluxListener | null };
  const sent: string[] = [];
  const flux: Flux = {
    isOpen: () => control.open,
    sendAudio: (pcm) => {
      if (!control.open) return false;
      sent.push(`audio ${new Uint8Array(pcm)[0]}`);
      return true;
    },
    endTurn: () => {
      if (!control.open) return false;
      sent.push("endTurn");
      return true;
    },
    connectNow: () => sent.push("connectNow"),
    stop: () => sent.push("stop"),
  };
  return {
    sent,
    startFlux: (listener: FluxListener) => {
      control.listener = listener;
      return flux;
    },
    open: () => {
      control.open = true;
      control.listener?.opened();
    },
    close: () => {
      control.open = false;
      control.listener?.closed();
    },
    emit: (event: FluxEvent) => control.listener?.heard(event),
  };
}

export type FakeFlux = ReturnType<typeof createFakeFlux>;

// Without a fake Flux there is no socket, so every utterance goes to the batch call.
export function createHarness(fakeFlux: FakeFlux | null = null) {
  const sent: RecordingCommand[] = [];
  const heard: Heard[] = [];
  const pending: Deferred[] = [];
  const logs: string[] = [];
  const clock = createClock();
  const transcribe = vi.fn(
    (audio: ArrayBuffer, mimeType: string) =>
      new Promise<Transcription>((resolve, reject) => {
        pending.push({ audio, mimeType, resolve, reject });
      }),
  );
  const flow = createRecording({
    sendRecording: (command) => sent.push(command),
    startFlux: (listener) => fakeFlux?.startFlux(listener) ?? null,
    transcribe,
    timers: { setTimer: clock.setTimer },
    log: (message) => logs.push(message),
    onHeard: (result) => heard.push(result),
  });
  const starts = () => sent.filter((command) => command.type === "start");
  const last = () => starts()[starts().length - 1].utteranceId;
  return { flow, sent, heard, pending, transcribe, starts, last, logs, clock };
}

export type Harness = ReturnType<typeof createHarness>;

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function hold(h: Harness, outcome: HoldOutcome): UtteranceId {
  h.flow.holdStarted();
  const utteranceId = h.last();
  h.flow.holdEnded(outcome);
  return utteranceId;
}

// A frame's first byte names it, so a test can follow it through the socket.
export function frame(h: Harness, utteranceId: UtteranceId, mark = 1): void {
  const pcm = new Uint8Array([mark, 0, 0, 0]).buffer;
  h.flow.micAudio({ type: "frames", utteranceId, pcm });
}

export function end(h: Harness, utteranceId: UtteranceId): void {
  h.flow.micAudio({ type: "end", utteranceId });
}

// One frame per mark, then the end of the frames.
export function sendAudio(h: Harness, utteranceId: UtteranceId, marks = [1]) {
  for (const mark of marks) frame(h, utteranceId, mark);
  end(h, utteranceId);
}

export function micFailed(
  h: Harness,
  utteranceId: UtteranceId,
  reason: MicFailure,
): void {
  h.flow.micAudio({ type: "failed", utteranceId, reason });
}

export async function resolveCall(
  h: Harness,
  index: number,
  result: Transcription,
) {
  h.pending[index].resolve(result);
  await flush();
}

export const words = (utteranceId: UtteranceId, text: string): Heard => ({
  kind: "words",
  utteranceId,
  words: text,
});

export const missed = (
  utteranceId: UtteranceId,
  cause: NotCaughtCause,
): Heard => ({
  kind: "notCaught",
  utteranceId,
  cause,
});
