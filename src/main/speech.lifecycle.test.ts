import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeAura,
  createHarness,
  failure,
  finish,
  play,
  resolveCall,
  said,
} from "./speech.harness";
import type { Harness } from "./speech.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

function streaming() {
  const aura = createFakeAura();
  const h = createHarness(aura);
  aura.open();
  return { aura, h };
}

const deadline = (h: Harness) => {
  const timer = h.timers.find((t) => t.ms === 60_000 && !t.cancelled);
  if (timer === undefined) throw new Error("no playback deadline");
  timer.fire();
};

describe("a line's life on the REST path", () => {
  it.each<{ name: string; end: (h: Harness, lineId: string) => void }>([
    { name: "playback finished", end: (h, lineId) => finish(h, lineId) },
    {
      name: "stopped by the key",
      end: (h) => {
        h.speech.holdStarted();
      },
    },
    { name: "muted", end: (h) => h.speech.setMuted(true) },
    { name: "its task cancelled", end: (h) => h.speech.cancelTask("t1") },
    { name: "timed out", end: (h) => deadline(h) },
    { name: "renderer reset", end: (h) => h.speech.rendererReset() },
  ])(
    "starts once its audio is sent and leaves with its id when $name",
    async ({ end }) => {
      const h = createHarness();
      const lineId = await play(h, said("Hello.", "t1", "answer"));
      expect(h.started).toEqual(["answer"]);
      expect(h.gone).toEqual([]);
      end(h, lineId);
      expect(h.gone).toEqual([{ kind: "answer", lineId }]);
    },
  );
});

describe("a REST line that never plays", () => {
  it("is not speaking while it is synthesized, and a mute then drops it unplayed", async () => {
    const h = createHarness();
    h.speech.speak(said("Hello."));
    expect(h.started).toEqual([]);
    h.speech.setMuted(true);
    await resolveCall(h, 0);
    expect(h.started).toEqual([]);
    expect(h.gone).toEqual([{ kind: "answer", lineId: null }]);
  });

  it.each([
    { name: "muted before it is queued", mute: true, cancel: false },
    { name: "for a cancelled task", mute: false, cancel: true },
  ])("never speaks when $name", ({ mute, cancel }) => {
    const h = createHarness();
    if (mute) h.speech.setMuted(true);
    if (cancel) h.speech.cancelTask("t1");
    h.speech.speak(said("Hello.", "t1", "notice"));
    expect(h.started).toEqual([]);
    expect(h.gone).toEqual([{ kind: "notice", lineId: null }]);
  });

  it("leaves unplayed when its synthesis fails", async () => {
    const h = createHarness();
    h.speech.speak(said("Hello."));
    await resolveCall(h, 0, failure("unreachable"));
    expect(h.gone).toEqual([{ kind: "answer", lineId: null }]);
  });

  it("drops a waiting line unplayed while an earlier one plays", async () => {
    const h = createHarness();
    const first = await play(h, said("One.", "t1", "answer"));
    h.speech.speak(said("Two.", "t2", "failure"));
    h.speech.cancelTask("t2");
    expect(h.gone).toEqual([{ kind: "failure", lineId: null }]);
    finish(h, first);
    expect(h.gone.at(-1)).toEqual({ kind: "answer", lineId: first });
  });
});

describe("a line's life on the Aura socket", () => {
  it("starts at its first chunk and leaves with its id when playback finishes", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello.", null, "notice"));
    expect(h.started).toEqual([]);
    aura.audio(1);
    aura.audio(2);
    expect(h.started).toEqual(["notice"]);
    aura.flushed();
    const lineId = h.chunks[0].lineId;
    finish(h, lineId);
    expect(h.gone).toEqual([{ kind: "notice", lineId }]);
  });

  it("leaves unplayed when it is cut before any audio", () => {
    const { h } = streaming();
    const feed = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "u1" });
    feed.push("Sure, ");
    feed.cut();
    expect(h.started).toEqual([]);
    expect(h.gone).toEqual([{ kind: "talk", lineId: null }]);
  });

  it("moves to REST without leaving when the socket closes before audio", async () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello."));
    aura.close();
    expect(h.gone).toEqual([]);
    await resolveCall(h, 0);
    expect(h.started).toEqual(["answer"]);
    finish(h, h.speeches[0].lineId);
    expect(h.gone).toEqual([{ kind: "answer", lineId: h.speeches[0].lineId }]);
  });

  it("leaves with its id when the key stops it mid-line", () => {
    const { aura, h } = streaming();
    h.speech.speak(said("Hello there."));
    aura.audio(1);
    const lineId = h.chunks[0].lineId;
    h.speech.holdStarted();
    expect(h.gone).toEqual([{ kind: "answer", lineId }]);
  });
});
