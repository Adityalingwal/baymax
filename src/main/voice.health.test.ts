import { describe, expect, it } from "vitest";
import type { Transcription } from "../providers/deepgram";
import type { SaidLine } from "./tasks/state";
import type { Harness } from "./voice.harness";
import {
  audio,
  createHarness,
  failed,
  hold,
  sendClip,
  synthesized,
  transcribed,
} from "./voice.harness";

const words = (text: string): Transcription => ({ kind: "words", words: text });
const line: SaidLine = { taskId: null, text: "Hello.", kind: "notice" };

type Deliver = (h: Harness, index: number) => Promise<void>;

const transcript =
  (result: Transcription): Deliver =>
  async (h, index) => {
    sendClip(h, hold(h));
    await transcribed(h, index, result);
  };

const clipFailed =
  (reason: "permissionDenied" | "noMicrophone" | "error"): Deliver =>
  async (h) => {
    h.voice.clipArrived({ utteranceId: hold(h), outcome: "failed", reason });
    await Promise.resolve();
  };

type HeardRow = {
  name: string;
  deliver: Deliver;
  up: string[];
  down: string[];
};

const heardRows: HeardRow[] = [
  {
    name: "words",
    deliver: transcript(words("hi")),
    up: ["ask hi"],
    down: ["voiceAvailable true", "ask hi"],
  },
  {
    name: "an empty transcript",
    deliver: transcript({ kind: "empty" }),
    up: ["notice wordsNotCaught"],
    down: ["voiceAvailable true", "notice wordsNotCaught"],
  },
  {
    name: "a transcription error",
    deliver: transcript({ kind: "failed", cause: "error", detail: "500" }),
    up: ["notice wordsNotCaught"],
    down: ["notice wordsNotCaught"],
  },
  {
    name: "a recorder error",
    deliver: clipFailed("error"),
    up: ["notice wordsNotCaught"],
    down: ["notice wordsNotCaught"],
  },
  ...(["unreachable", "keyRejected", "noCredit"] as const).map((cause) => ({
    name: `Deepgram ${cause}`,
    deliver: transcript(failed(cause)),
    up: ["voiceAvailable false"],
    down: [],
  })),
  {
    name: "a blocked microphone",
    deliver: clipFailed("permissionDenied"),
    up: ["notice micBlocked"],
    down: ["notice micBlocked"],
  },
  {
    name: "no microphone",
    deliver: clipFailed("noMicrophone"),
    up: ["notice noMicrophone"],
    down: ["notice noMicrophone"],
  },
];

describe("what was heard", () => {
  it.each(heardRows)("$name while STT is up", async ({ deliver, up }) => {
    const h = createHarness();
    await deliver(h, 0);
    expect(h.calls).toEqual(up);
  });

  it.each(heardRows)("$name while STT is down", async ({ deliver, down }) => {
    const h = createHarness();
    await transcript(failed("unreachable"))(h, 0);
    expect(h.calls.splice(0)).toEqual(["voiceAvailable false"]);
    await deliver(h, 1);
    expect(h.calls).toEqual(down);
  });
});

describe("voice health from STT", () => {
  it("tells main once when STT goes down and once when it is back", async () => {
    const h = createHarness();
    await transcript(failed("unreachable"))(h, 0);
    await transcript(failed("noCredit"))(h, 1);
    await transcript(words("hi"))(h, 2);
    expect(h.calls).toEqual([
      "voiceAvailable false",
      "voiceAvailable true",
      "ask hi",
    ]);
  });

  it("keeps STT down when an older success settles after a newer failure", async () => {
    const h = createHarness();
    sendClip(h, hold(h));
    sendClip(h, hold(h));
    await transcribed(h, 1, failed("unreachable"));
    await transcribed(h, 0, words("hi"));
    expect(h.calls).toEqual(["voiceAvailable false", "ask hi"]);
  });

  it("shows voice down from the start without a Deepgram key", async () => {
    const h = createHarness({ deepgramKeyPresent: false });
    expect(h.calls).toEqual(["voiceAvailable false"]);
    await transcript(failed("keyRejected"))(h, 0);
    expect(h.calls).toEqual(["voiceAvailable false"]);
  });
});

describe("voice health from TTS", () => {
  it("tells main when TTS goes down while STT is up, and when it is back", async () => {
    const h = createHarness();
    h.voice.say(line);
    await synthesized(h, 0, failed("unreachable"));
    expect(h.calls).toEqual(["voiceAvailable false"]);
    h.voice.say(line);
    await synthesized(h, 1, audio);
    expect(h.calls).toEqual(["voiceAvailable false", "voiceAvailable true"]);
  });

  it("never lets a TTS success hide an STT outage", async () => {
    const h = createHarness();
    await transcript(failed("unreachable"))(h, 0);
    h.voice.say(line);
    await synthesized(h, 0, failed("unreachable"));
    h.voice.say(line);
    await synthesized(h, 1, audio);
    expect(h.calls).toEqual(["voiceAvailable false"]);
  });

  it("never lets an STT success hide a TTS outage", async () => {
    const h = createHarness();
    h.voice.say(line);
    await synthesized(h, 0, failed("unreachable"));
    await transcript(words("hi"))(h, 0);
    expect(h.calls).toEqual(["voiceAvailable false", "ask hi"]);
  });
});
