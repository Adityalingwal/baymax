import { describe, expect, it } from "vitest";
import { createFakeAura } from "./speech.harness";
import type { SaidLine } from "../../src/main/tasks/state";
import {
  audio,
  createHarness,
  failed,
  hold,
  sendAudio,
  synthesized,
  transcribed,
  waitingQuestion,
} from "./voice.harness";
import type { Transcription } from "../../src/providers/deepgram";
import type { UtteranceId } from "../../src/shared/cards";
import type { Harness } from "./voice.harness";

const line = (text: string): SaidLine => ({
  taskId: "t1",
  text,
  kind: "failure",
});

describe("voice before start", () => {
  it("ignores state calls but already speaks and silences", () => {
    const h = createHarness({ started: false });
    h.voice.holdChanged("listening", null);
    h.voice.holdChanged("idle", "accept");
    h.voice.micAudio({ type: "failed", utteranceId: "u1", reason: "error" });
    h.voice.setMuted(true);
    expect(h.recordings).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([
      "hold change before start: ignored",
      "hold change before start: ignored",
      "mic audio before start: ignored",
      "mute before start: ignored",
    ]);
    h.voice.say(line("Hello."));
    expect(h.syntheses.map((call) => call.text)).toEqual(["Hello."]);
    h.voice.silence("t1");
    h.voice.say(line("Again."));
    expect(h.syntheses).toHaveLength(1);
  });

  it("tells main a voice change that came before start", async () => {
    const h = createHarness({ started: false });
    h.voice.say(line("Hello."));
    await synthesized(h, 0, failed("unreachable"));
    expect(h.calls).toEqual([]);
    h.voice.start(h.state);
    expect(h.calls).toEqual(["voiceAvailable false"]);
  });
});

describe("hold routing", () => {
  it("silences speech before the recording starts", async () => {
    const h = createHarness();
    h.voice.say(line("Hello."));
    await synthesized(h, 0, audio);
    expect(h.speeches).toHaveLength(1);
    h.voice.holdChanged("listening", null);
    expect(h.timeline).toEqual([
      "synthesize Hello.",
      "stop playback",
      "recording start",
    ]);
  });

  it("stops the recording at release, then lets speech resume", () => {
    const h = createHarness();
    h.voice.holdChanged("listening", null);
    h.voice.say(line("Hello."));
    expect(h.syntheses).toHaveLength(0);
    h.voice.holdChanged("idle", "accept");
    expect(h.timeline).toEqual([
      "recording start",
      "recording stop",
      "synthesize Hello.",
    ]);
  });

  it("keeps working when the recording send throws", () => {
    const h = createHarness();
    h.control.recordingFails = true;
    expect(() => {
      h.voice.holdChanged("listening", null);
      h.voice.holdChanged("idle", "accept");
    }).not.toThrow();
    expect(h.logs).toEqual([
      "sendRecording threw: Error: window gone",
      "sendRecording threw: Error: window gone",
    ]);
  });
});

describe("renderer reset during a hold", () => {
  it("keeps speech quiet until the key is released", () => {
    const h = createHarness();
    h.voice.holdChanged("listening", null);
    h.voice.rendererReset();
    h.voice.say(line("Hello."));
    expect(h.syntheses).toHaveLength(0);
    h.voice.holdChanged("idle", "accept");
    expect(h.syntheses.map((call) => call.text)).toEqual(["Hello."]);
  });
});

describe("stop", () => {
  it("drops a transcript that settles after it", async () => {
    const h = createHarness();
    sendAudio(h, hold(h));
    h.voice.stop();
    await transcribed(h, 0, { kind: "words", words: "late" });
    expect(h.asked).toEqual([]);
  });

  it("still speaks, so the restart line can be heard", async () => {
    const h = createHarness();
    h.voice.holdChanged("listening", null);
    h.voice.stop();
    h.voice.say(line("Restarting."));
    await synthesized(h, 0, audio);
    expect(h.speeches).toHaveLength(1);
  });
});

describe("a state throw outside a listener", () => {
  it("goes to the restart path from a transcript", async () => {
    const h = createHarness();
    sendAudio(h, hold(h));
    h.waiting.stateFails = true;
    await transcribed(h, 0, { kind: "words", words: "hello" });
    expect(h.failures).toEqual(["Error: ask broke"]);
  });

  it("goes to the restart path from a speech health change", async () => {
    const h = createHarness();
    h.waiting.stateFails = true;
    h.voice.say(line("Hello."));
    await synthesized(h, 0, {
      kind: "failed",
      cause: "unreachable",
      detail: "",
    });
    expect(h.failures).toEqual(["Error: voice state broke"]);
  });
});

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

const timing = (h: ReturnType<typeof createHarness>) =>
  h.logs.filter((message) => message.startsWith("first spoken line"));

describe("streamed audio and transcripts reaching their targets", () => {
  it("sends streamed chunks to the renderer and times the first one", () => {
    const aura = createFakeAura();
    const h = createHarness({ aura });
    aura.open();
    h.control.now = 1000;
    sendAudio(h, hold(h));
    h.voice.say(line("Hi."));
    h.control.now = 1800;
    aura.audio(1);
    aura.audio(2);
    expect(h.chunks).toHaveLength(2);
    expect(timing(h)).toEqual(["first spoken line 800 ms after release"]);
  });

  it("asks with the final transcript and times it from the release", async () => {
    const h = createHarness();
    h.control.now = 1000;
    sendAudio(h, hold(h));
    h.control.now = 1450.6;
    await transcribed(h, 0, { kind: "words", words: "hi" });
    expect(h.logs).toContain("final transcript 451 ms after release");
    expect(h.calls).toEqual(["ask hi"]);
  });
});

describe("a release while the talker is silent", () => {
  it("says nothing until the talker speaks, past the transcript deadline", () => {
    const h = createHarness();
    hold(h);
    h.advance(5000);
    expect(h.syntheses.map((call) => call.text)).toEqual([]);
  });
});
