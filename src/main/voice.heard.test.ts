import { describe, expect, it } from "vitest";
import type { Transcription } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import type { Harness } from "./voice.harness";
import {
  createHarness,
  failed,
  hold,
  sendAudio,
  transcribed,
  waitingQuestion,
} from "./voice.harness";

const words = (text: string): Transcription => ({ kind: "words", words: text });

function heldAndSent(h: Harness): UtteranceId {
  const utteranceId = hold(h);
  sendAudio(h, utteranceId);
  return utteranceId;
}

describe("admitted utterances", () => {
  it("asks with the waiting question shown when the key went down", async () => {
    const h = createHarness();
    h.waiting.waiting = waitingQuestion("q1");
    const first = heldAndSent(h);
    h.waiting.waiting = waitingQuestion("q2");
    await transcribed(h, 0, words("first"));
    const second = heldAndSent(h);
    await transcribed(h, 1, words("second"));
    expect(h.asked).toEqual([
      { words: "first", utteranceId: first, waiting: waitingQuestion("q1") },
      { words: "second", utteranceId: second, waiting: waitingQuestion("q2") },
    ]);
  });
});

const droppedRows: { name: string; result: Transcription }[] = [
  { name: "words", result: words("late") },
  { name: "a failure", result: failed("unreachable") },
];

describe("dropped transcripts", () => {
  it.each(droppedRows)(
    "drops $name that settles after a renderer reset",
    async ({ result }) => {
      const h = createHarness();
      heldAndSent(h);
      h.voice.rendererReset();
      await transcribed(h, 0, result);
      expect(h.calls).toEqual([]);
      expect(h.logs).toContain("transcript dropped: its hold already ended");
    },
  );

  it.each(droppedRows)(
    "drops $name of an older utterance that settles after a newer key-down",
    async ({ result }) => {
      const h = createHarness();
      heldAndSent(h);
      h.voice.holdChanged("listening", null);
      await transcribed(h, 0, result);
      h.voice.holdChanged("idle", "discard");
      expect(h.calls).toEqual([]);
      expect(
        h.logs.some((line) => line.endsWith("utterance not admitted")),
      ).toBe(true);
    },
  );
});
