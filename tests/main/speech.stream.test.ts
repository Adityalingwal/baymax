import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeAura,
  createHarness,
  failure,
  finish,
  resolveCall,
  said,
} from "./speech.harness";
import { takeClauses } from "../../src/main/clauses";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

function streaming() {
  const aura = createFakeAura();
  const h = createHarness(aura);
  aura.open();
  return { aura, h };
}

const speak = (text: string) => `speak ${text}`;

describe("a line on the Aura socket (L10)", () => {
  it("speaks clause by clause with a Flush after the first clause and one at the end", () => {
    const { aura, h } = streaming();
    h.speech.speak(
      said("Sure, I'll check tomorrow's forecast. Rain decides it."),
    );
    expect(aura.sent).toEqual([
      speak("Sure,"),
      "flush",
      speak("I'll check tomorrow's forecast."),
      speak("Rain decides it."),
      "flush",
    ]);
    expect(h.synthesize).not.toHaveBeenCalled();
  });

  it("flushes a one-clause line once", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello there."));
    expect(aura.sent).toEqual([speak("Hello there."), "flush"]);
  });

  it("sends chunks in seq order and the end only after every Flushed, then waits for playback", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("One, two."));
    h.speech.speak(said("Next."));
    aura.audio(1);
    aura.flushed();
    aura.audio(2);
    expect(h.ends).toEqual([]);
    aura.flushed();
    const lineId = h.chunks[0].lineId;
    expect(h.chunks.map(({ seq, sampleRate }) => [seq, sampleRate])).toEqual([
      [0, 24_000],
      [1, 24_000],
    ]);
    expect(h.chunks.every((chunk) => chunk.lineId === lineId)).toBe(true);
    expect(h.ends).toEqual([{ lineId }]);
    expect(aura.sent).not.toContain(speak("Next."));
    finish(h, lineId);
    expect(aura.sent.at(-2)).toBe(speak("Next."));
  });
});

describe("cutting a streaming line (L10)", () => {
  it.each([
    [
      "a key press",
      (h: ReturnType<typeof createHarness>) => h.speech.holdStarted(),
    ],
    ["mute", (h: ReturnType<typeof createHarness>) => h.speech.setMuted(true)],
    [
      "cancel",
      (h: ReturnType<typeof createHarness>) => h.speech.cancelTask("t1"),
    ],
  ])(
    "%s restarts the socket, stops the renderer and drops later audio",
    (_name, act) => {
      const { aura, h } = streaming();
      h.speech.speak(said("Hello there."));
      aura.audio(1);
      act(h);
      aura.audio(2);
      aura.flushed();
      const lineId = h.chunks[0].lineId;
      expect(aura.sent.at(-1)).toBe("restart");
      expect(h.stops).toEqual([{ lineId }]);
      expect(h.chunks).toHaveLength(1);
      expect(h.ends).toEqual([]);
    },
  );

  it("restarts the socket for a line the renderer never reported once its deadline passes", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello there."));
    aura.audio(1);
    h.timers[0].fire();
    expect(aura.sent.at(-1)).toBe("restart");
    expect(h.stops).toEqual([{ lineId: h.chunks[0].lineId }]);
  });
});

describe("the REST backup (L11)", () => {
  it("uses REST with the whole text when the socket is not open at the line's start", () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    h.speech.speak(said("Hello there."));
    expect(h.texts()).toEqual(["Hello there."]);
    expect(aura.sent).toEqual([]);
  });

  it("sends the line to REST whole when the socket closes before any audio", async () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello there."));
    aura.close();
    expect(h.texts()).toEqual(["Hello there."]);
    await resolveCall(h, 0);
    expect(h.speeches).toHaveLength(1);
    expect(h.ends).toEqual([]);
  });

  it("ends a line where it is when the socket closes after some audio, never replaying it", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello there."));
    h.speech.speak(said("Next."));
    aura.audio(1);
    aura.close();
    const lineId = h.chunks[0].lineId;
    expect(h.ends).toEqual([{ lineId }]);
    expect(h.synthesize).not.toHaveBeenCalled();
    finish(h, lineId);
    expect(h.texts()).toEqual(["Next."]);
  });

  it("calls voice back when streamed audio arrives after a REST failure", async () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    h.speech.speak(said("First."));
    await resolveCall(h, 0, failure("unreachable"));
    aura.open();
    h.speech.speak(said("Second."));
    aura.audio(1);
    expect(h.voice).toEqual([
      { available: false, cause: "unreachable" },
      { available: true, cause: null },
    ]);
  });
});

describe("the REST backup after a failed send or a restart (L11)", () => {
  it("takes the socket-failure path when a send fails: REST with the whole text before any audio", () => {
    const { aura, h } = streaming();
    aura.failSends();
    h.speech.speak(said("Hello there."));
    expect(aura.sent).toEqual(["restart"]);
    expect(h.texts()).toEqual(["Hello there."]);
    expect(h.ends).toEqual([]);
    aura.open();
    aura.audio(1);
    aura.flushed();
    expect(h.chunks).toEqual([]);
  });

  it("sends the next line to REST while the restarted socket is not open", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello there.", "t1"));
    h.speech.speak(said("Next.", "t2"));
    aura.audio(1);
    h.speech.cancelTask("t1");
    expect(aura.sent.at(-1)).toBe("restart");
    expect(h.texts()).toEqual(["Next."]);
  });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("a line the talker writes as it goes", () => {
  it("streams clauses to the Aura socket as the text arrives, flushing the first clause and the end", () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    aura.open();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    line.push("Sure, I'll");
    expect(aura.sent).toEqual(["speak Sure,", "flush"]);
    line.push(" check the forecast. The rain");
    line.push(" decides it.");
    line.end();
    line.push("ignored");
    expect(aura.sent).toEqual([
      "speak Sure,",
      "flush",
      "speak I'll check the forecast.",
      "speak The rain decides it.",
      "flush",
    ]);
  });

  it("waits for the whole text before the REST call when the socket is not open", () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    h.speech.speak(said("Next."));
    line.push("Hello ");
    expect(h.texts()).toEqual([]);
    line.push("there.");
    line.end();
    expect(h.texts()).toEqual(["Hello there."]);
  });

  it("drops a line that ended with no text and goes on", () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    h.speech.speak(said("Next."));
    line.end();
    expect(h.texts()).toEqual(["Next."]);
  });
});

describe("a talker line's backup and audio", () => {
  it("goes to REST with its whole text when the socket closes before any audio", () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    aura.open();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    line.push("Hello");
    aura.close();
    line.push(" there.");
    expect(h.texts()).toEqual([]);
    line.end();
    expect(h.texts()).toEqual(["Hello there."]);
  });

  it("tells when a line's first audio reached the renderer", async () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    h.speech.speak(said("Clip.", "t1", "failure"));
    await resolveCall(h, 0);
    expect(h.started).toEqual(["failure"]);
    h.speech.playbackFinished({
      lineId: h.speeches[0].lineId,
      outcome: "ended",
    });
    aura.open();
    h.speech.speak(said("Streamed.", "t1", "talk"));
    aura.audio(1);
    aura.audio(2);
    expect(h.started).toEqual(["failure", "talk"]);
  });
});

describe("a talker line cut or failing mid-stream", () => {
  it("cut() stops its playback and lets the next line play", async () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "answer", key: null });
    line.push("Partial words.");
    line.end();
    h.speech.speak(said("Given text, whole."));
    await resolveCall(h, 0);
    const lineId = h.speeches[0].lineId;
    line.cut();
    expect(h.stops).toEqual([{ lineId }]);
    expect(h.texts()).toEqual(["Partial words.", "Given text, whole."]);
  });

  it("restarts the socket and ends the line where it is when a later send fails after audio, never replaying it", () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    aura.open();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    line.push("Sure, ");
    aura.audio(1);
    aura.failSends();
    line.push("more words. ");
    expect(aura.sent).toEqual(["speak Sure,", "flush", "restart"]);
    expect(h.ends).toEqual([{ lineId: h.chunks[0].lineId }]);
    expect(h.synthesize).not.toHaveBeenCalled();
  });
});

type Row = {
  name: string;
  text: string;
  ended: boolean;
  clauses: string[];
  rest: string;
};

const rows: Row[] = [
  {
    name: "a short line still being written waits",
    text: "I'll check",
    ended: false,
    clauses: [],
    rest: "I'll check",
  },
  {
    name: "a short line that ended is one clause",
    text: "Hi there.",
    ended: true,
    clauses: ["Hi there."],
    rest: "",
  },
  {
    name: "punctuation and a space end a clause",
    text: "Sure, I'll check tomorrow's forecast. The rain",
    ended: false,
    clauses: ["Sure,", "I'll check tomorrow's forecast."],
    rest: "The rain",
  },
  {
    name: "a mark not yet followed by a space waits, since 3.5 may still be coming",
    text: "It is 3.",
    ended: false,
    clauses: [],
    rest: "It is 3.",
  },
  {
    name: "about 40 characters without punctuation are cut at the last space",
    text: "this sentence has no punctuation at all and keeps on going",
    ended: false,
    clauses: ["this sentence has no punctuation at all"],
    rest: "and keeps on going",
  },
  {
    name: "a long word with no space is cut at 40 characters",
    text: "a".repeat(45),
    ended: false,
    clauses: ["a".repeat(40)],
    rest: "aaaaa",
  },
  {
    name: "blank text gives nothing",
    text: "   ",
    ended: true,
    clauses: [],
    rest: "",
  },
];

describe("clauses for streamed speech", () => {
  it.each(rows)("$name", ({ text, ended, clauses, rest }) => {
    expect(takeClauses(text, ended)).toEqual({ clauses, rest });
  });
});
