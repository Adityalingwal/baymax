import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeAura,
  createHarness,
  resolveCall,
  said,
} from "./speech.harness";

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

describe('"One moment." and its talker line', () => {
  it("goes ahead of its talker line still waiting for its words", () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    h.speech.sayMoment("k1");
    line.push("Hello there.");
    line.end();
    expect(h.texts()).toEqual(["One moment."]);
  });

  it("takes back its talker line that has words but no audio yet, and plays it after", async () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    line.push("Hello there.");
    line.end();
    h.speech.sayMoment("k1");
    expect(h.calls[0].signal.aborted).toBe(true);
    await resolveCall(h, 1);
    h.speech.playbackFinished({
      lineId: h.speeches[0].lineId,
      outcome: "ended",
    });
    expect(h.texts()).toEqual(["Hello there.", "One moment.", "Hello there."]);
  });

  it("leaves another generation's talker line where it is", () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k2" });
    line.push("Older reply.");
    line.end();
    h.speech.sayMoment("k1");
    expect(h.calls[0].signal.aborted).toBe(false);
    expect(h.texts()).toEqual(["Older reply."]);
  });

  it("restarts the socket for its streaming talker line with no audio yet, which waits behind it", () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    aura.open();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    line.push("Hi, there");
    h.speech.sayMoment("k1");
    expect(aura.sent).toEqual(["speak Hi,", "flush", "restart"]);
    expect(h.texts()).toEqual(["One moment."]);
  });
});
