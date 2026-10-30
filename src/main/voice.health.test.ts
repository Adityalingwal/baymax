import { describe, expect, it } from "vitest";
import type { UtteranceId } from "../shared/cards";
import type { VoicePhase } from "../shared/ipc";
import type { LineFeed } from "./speech";
import {
  audio,
  createHarness,
  failed,
  hold,
  sendAudio,
  synthesized,
  transcribed,
} from "./voice.harness";
import type { Harness } from "./voice.harness";
import type { Transcription } from "../providers/deepgram";
import type { SaidLine } from "./tasks/state";

const listening: VoicePhase = { phase: "listening" };
const thinking: VoicePhase = { phase: "thinking" };
const idle: VoicePhase = { phase: "idle" };

const names = (h: Harness) => h.phases.map((phase) => phase.phase);

// A held question whose words reached main's state, which started a front call for task t1.
async function asked(h: Harness): Promise<LineFeed> {
  let feed: LineFeed | null = null;
  h.waiting.onAsk = (utteranceId: UtteranceId | null) => {
    feed = h.voice.talk({ taskId: "t1", kind: "talk", key: utteranceId });
  };
  sendAudio(h, hold(h));
  await transcribed(h, 0, { kind: "words", words: "how does Hermes work" });
  if (feed === null) throw new Error("no front call");
  return feed;
}

function lastLine(h: Harness) {
  const phase = h.phases.at(-1);
  return phase?.phase === "speaking" ? phase.line : null;
}

describe("the voice phase", () => {
  it("listens, thinks until the front call's first audio, speaks, then goes idle", async () => {
    const h = createHarness();
    const feed = await asked(h);
    expect(h.phases).toEqual([listening, thinking]);
    feed.push("Sure, I'll check.");
    feed.end();
    expect(h.phases.at(-1)).toEqual(thinking);
    await synthesized(h, 0, audio);
    const lineId = h.speeches[0].lineId;
    expect(lastLine(h)).toEqual({ lineId, taskId: "t1", kind: "talk" });
    h.voice.playbackFinished({ lineId, outcome: "ended" });
    expect(h.phases.at(-1)).toEqual(idle);
  });

  it.each<{ name: string; end: (h: Harness, feed: LineFeed) => void }>([
    { name: "the front call is cancelled", end: (_h, feed) => feed.cut() },
    { name: "mute drops its line", end: (h) => h.voice.setMuted(true) },
    { name: "its line ends with no words", end: (_h, feed) => feed.end() },
    { name: "the renderer resets", end: (h) => h.voice.rendererReset() },
  ])("stops thinking when $name", async ({ end }) => {
    const h = createHarness();
    const feed = await asked(h);
    end(h, feed);
    expect(h.phases).toEqual([listening, thinking, idle]);
  });
});

describe("the voice phase after a failed or muted turn", () => {
  it("never shows a failed attempt waiting for Retry as thinking", async () => {
    const h = createHarness();
    const feed = await asked(h);
    feed.end();
    h.voice.say({
      taskId: "t1",
      text: "Sorry, I missed that.",
      kind: "failure",
    });
    await synthesized(h, 0, audio);
    expect(names(h)).toEqual(["listening", "thinking", "idle", "speaking"]);
    expect(lastLine(h)?.kind).toBe("failure");
  });

  it("thinks through a muted front call only until its line is dropped", async () => {
    const h = createHarness();
    h.voice.setMuted(true);
    await asked(h);
    expect(h.phases).toEqual([listening, thinking, idle]);
  });

  it.each([
    { name: "a discarded hold", run: (h: Harness) => void hold(h, "discard") },
    {
      name: "words not caught",
      run: async (h: Harness) => {
        sendAudio(h, hold(h));
        await transcribed(h, 0, { kind: "empty" });
      },
    },
    {
      name: "words main's state dropped",
      run: async (h: Harness) => {
        sendAudio(h, hold(h));
        await transcribed(h, 0, { kind: "words", words: "  " });
      },
    },
  ])("goes back to idle after $name", async ({ run }) => {
    const h = createHarness();
    await run(h);
    expect(h.phases.at(-1)).toEqual(idle);
  });
});

describe("the voice phase beside other lines", () => {
  it("listens over a line that was speaking, which the key silences", async () => {
    const h = createHarness();
    h.voice.say({ taskId: null, text: "Voice is back.", kind: "notice" });
    await synthesized(h, 0, audio);
    expect(lastLine(h)).toMatchObject({ taskId: null, kind: "notice" });
    hold(h, "discard");
    expect(names(h)).toEqual(["speaking", "listening", "idle"]);
  });

  it("shows another task's answer as speaking while a turn waits for its words, then thinks again", async () => {
    const h = createHarness();
    sendAudio(h, hold(h));
    h.voice.say({ taskId: "t0", text: "Hermes runs a loop.", kind: "answer" });
    await synthesized(h, 0, audio);
    expect(lastLine(h)).toMatchObject({ taskId: "t0", kind: "answer" });
    const lineId = h.speeches[0].lineId;
    h.voice.playbackFinished({ lineId, outcome: "ended" });
    expect(h.phases.at(-1)).toEqual(thinking);
  });

  it("drops an earlier turn when a new hold starts", async () => {
    const h = createHarness();
    await asked(h);
    hold(h, "discard");
    expect(h.phases.slice(-2)).toEqual([listening, idle]);
  });
});

const words = (text: string): Transcription => ({ kind: "words", words: text });
const line: SaidLine = { taskId: null, text: "Hello.", kind: "notice" };

type Deliver = (h: Harness, index: number) => Promise<void>;

const transcript =
  (result: Transcription): Deliver =>
  async (h, index) => {
    sendAudio(h, hold(h));
    await transcribed(h, index, result);
  };

const clipFailed =
  (reason: "permissionDenied" | "noMicrophone" | "error"): Deliver =>
  async (h) => {
    h.voice.micAudio({ type: "failed", utteranceId: hold(h), reason });
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
    sendAudio(h, hold(h));
    sendAudio(h, hold(h));
    await transcribed(h, 1, failed("unreachable"));
    await transcribed(h, 0, words("hi"));
    expect(h.calls).toEqual(["voiceAvailable false", "ask hi"]);
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
