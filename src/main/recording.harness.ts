import { vi } from "vitest";
import type { Transcription } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import type { Clip, RecordingCommand } from "../shared/ipc";
import type { HoldOutcome } from "./hold";
import { createRecording } from "./recording";
import type { Heard, NotCaughtCause } from "./recording";

type Deferred = {
  resolve: (result: Transcription) => void;
  reject: (error: unknown) => void;
};

export function createHarness() {
  const sent: RecordingCommand[] = [];
  const heard: Heard[] = [];
  const pending: Deferred[] = [];
  const transcribe = vi.fn(
    () =>
      new Promise<Transcription>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const flow = createRecording({
    sendRecording: (command) => sent.push(command),
    transcribe,
    onHeard: (result) => heard.push(result),
  });
  const starts = () => sent.filter((command) => command.type === "start");
  return { flow, sent, heard, pending, transcribe, starts };
}

export type Harness = ReturnType<typeof createHarness>;

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function hold(h: Harness, outcome: HoldOutcome): UtteranceId {
  h.flow.holdStarted();
  const utteranceId = h.starts()[h.starts().length - 1].utteranceId;
  h.flow.holdEnded(outcome);
  return utteranceId;
}

export function recorded(utteranceId: UtteranceId, bytes = 4): Clip {
  const audio = new ArrayBuffer(bytes);
  return { utteranceId, outcome: "recorded", audio, mimeType: "audio/webm" };
}

export function failedClip(
  utteranceId: UtteranceId,
  reason: "permissionDenied" | "noMicrophone" | "error",
): Clip {
  return { utteranceId, outcome: "failed", reason };
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
