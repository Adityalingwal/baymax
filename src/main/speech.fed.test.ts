import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeAura,
  createHarness,
  finish,
  play,
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
  it("goes ahead of its talker line still waiting for its words, which plays after it", async () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    h.speech.sayMoment("k1");
    await resolveCall(h, 0);
    line.push("Hello there.");
    line.end();
    expect(h.texts()).toEqual(["One moment."]);
    finish(h, h.speeches[0].lineId);
    expect(h.texts()).toEqual(["One moment.", "Hello there."]);
  });

  it("is skipped when its talker line already has words, so it never delays them", () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    line.push("Hello there.");
    line.end();
    h.speech.sayMoment("k1");
    expect(h.calls[0].signal.aborted).toBe(false);
    expect(h.texts()).toEqual(["Hello there."]);
  });

  it("gives way to its talker's first words while it has no audio yet", () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    h.speech.sayMoment("k1");
    line.push(" ");
    expect(h.calls[0].signal.aborted).toBe(false);
    line.push("Hello there.");
    line.end();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.texts()).toEqual(["One moment.", " Hello there."]);
  });
});

describe('"One moment." and other lines', () => {
  it("leaves another generation's talker line where it is", () => {
    const h = createHarness();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k2" });
    line.push("Older reply.");
    line.end();
    h.speech.sayMoment("k1");
    expect(h.calls[0].signal.aborted).toBe(false);
    expect(h.texts()).toEqual(["Older reply."]);
  });

  it("restarts the socket when it streams with no audio yet and its talker's first words come", () => {
    const aura = createFakeAura();
    const h = createHarness(aura);
    aura.open();
    const line = h.speech.speakFed({ taskId: "t1", kind: "talk", key: "k1" });
    h.speech.sayMoment("k1");
    line.push("Hi, there");
    line.end();
    expect(aura.sent).toEqual(["speak One moment.", "flush", "restart"]);
    expect(h.texts()).toEqual(["Hi, there"]);
  });

  it("is dropped by its generation's end while it waits or synthesizes, never once playing", async () => {
    const h = createHarness();
    const blocker = await play(h, said("blocker", "t2"));
    h.speech.sayMoment("k1");
    h.speech.dropMoment("k1");
    finish(h, blocker);
    expect(h.texts()).toEqual(["blocker"]);
    h.speech.sayMoment("k2");
    h.speech.dropMoment("k2");
    expect(h.calls[1].signal.aborted).toBe(true);
    h.speech.sayMoment("k3");
    await resolveCall(h, 2);
    h.speech.dropMoment("k3");
    expect(h.stops).toEqual([]);
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
