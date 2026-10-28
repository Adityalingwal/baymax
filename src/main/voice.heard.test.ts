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
  it("still asks with an older accepted utterance's words that come while a newer key is held", async () => {
    const h = createHarness();
    const first = heldAndSent(h);
    h.voice.holdChanged("listening", null);
    await transcribed(h, 0, words("first"));
    expect(h.asked.map((asked) => [asked.words, asked.utteranceId])).toEqual([
      ["first", first],
    ]);
  });

  it("sends two holds in transcription at once to ask with their own waiting question", async () => {
    const h = createHarness();
    h.waiting.waiting = waitingQuestion("q1");
    const first = heldAndSent(h);
    h.waiting.waiting = waitingQuestion("q2");
    const second = heldAndSent(h);
    await transcribed(h, 0, words("first"));
    await transcribed(h, 1, words("second"));
    expect(h.asked).toEqual([
      { words: "first", utteranceId: first, waiting: waitingQuestion("q1") },
      { words: "second", utteranceId: second, waiting: waitingQuestion("q2") },
    ]);
  });

  it("forgets a discarded hold, so it never pushes an accepted one out", async () => {
    const h = createHarness();
    heldAndSent(h);
    for (let index = 0; index < 16; index += 1) hold(h, "discard");
    await transcribed(h, 0, words("kept"));
    expect(h.calls).toEqual(["ask kept"]);
  });

  it("forgets a hold that a new hold replaced before its release", async () => {
    const h = createHarness();
    heldAndSent(h);
    for (let index = 0; index < 16; index += 1) {
      h.voice.holdChanged("listening", null);
    }
    h.voice.holdChanged("idle", "discard");
    await transcribed(h, 0, words("kept"));
    expect(h.calls).toEqual(["ask kept"]);
  });
});

const droppedRows: { name: string; result: Transcription; log: string }[] = [
  { name: "words", result: words("late"), log: "words dropped" },
  {
    name: "a failure",
    result: failed("unreachable"),
    log: "notCaught dropped",
  },
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
    "drops $name of an utterance pushed out by newer holds",
    async ({ result, log }) => {
      const h = createHarness();
      heldAndSent(h);
      for (let index = 0; index < 16; index += 1) hold(h);
      await transcribed(h, 0, result);
      expect(h.calls).toEqual([]);
      expect(h.logs).toContain(`${log}: not an accepted hold`);
    },
  );

  it("keeps sixteen utterances", async () => {
    const h = createHarness();
    heldAndSent(h);
    for (let index = 0; index < 15; index += 1) hold(h);
    await transcribed(h, 0, words("kept"));
    expect(h.calls).toEqual(["ask kept"]);
  });
});
