import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeAura,
  createHarness,
  failure,
  finish,
  resolveCall,
  said,
} from "./speech.harness";

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

describe("clearing a streaming line (L10)", () => {
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
    "%s sends Clear, stops the renderer and drops later audio",
    (_name, act) => {
      const { aura, h } = streaming();
      h.speech.speak(said("Hello there."));
      aura.audio(1);
      act(h);
      aura.audio(2);
      aura.flushed();
      const lineId = h.chunks[0].lineId;
      expect(aura.sent.at(-1)).toBe("clear");
      expect(h.stops).toEqual([{ lineId }]);
      expect(h.chunks).toHaveLength(1);
      expect(h.ends).toEqual([]);
    },
  );

  it("clears a line the renderer never reported once its deadline passes", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello there."));
    aura.audio(1);
    h.timers[0].fire();
    expect(aura.sent.at(-1)).toBe("clear");
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
