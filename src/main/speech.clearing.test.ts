import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "./speech.harness";
import {
  audio,
  createHarness,
  failure,
  finish,
  play,
  resolveCall,
  said,
} from "./speech.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// Each clears task t1's speech; restore undoes what the clear left behind (the key, the mute).
const clearers: {
  name: string;
  clear: (h: Harness) => void;
  restore: (h: Harness) => void;
}[] = [
  {
    name: "hold",
    clear: (h) => h.speech.holdStarted(),
    restore: (h) => h.speech.holdEnded(),
  },
  {
    name: "mute",
    clear: (h) => h.speech.setMuted(true),
    restore: (h) => h.speech.setMuted(false),
  },
  {
    name: "cancel",
    clear: (h) => h.speech.cancelTask("t1"),
    restore: () => undefined,
  },
];

describe.each(clearers)("$name clears speech", ({ clear, restore }) => {
  it("a pending line is dropped and never synthesized", async () => {
    const h = createHarness();
    const blocker = await play(h, said("blocker", "t2"));
    h.speech.speak(said("pending"));
    clear(h);
    restore(h);
    finish(h, blocker);
    expect(h.texts()).toEqual(["blocker"]);
  });

  it("a synthesizing line is aborted and its audio, resolved afterwards, is never sent", async () => {
    const h = createHarness();
    h.speech.speak(said("synthesizing"));
    clear(h);
    expect(h.calls[0].signal.aborted).toBe(true);
    await resolveCall(h, 0);
    restore(h);
    expect(h.speeches).toEqual([]);
    expect(h.texts()).toEqual(["synthesizing"]);
  });

  it("a playing line is stopped by its id and its deadline cancelled", async () => {
    const h = createHarness();
    const lineId = await play(h, said("playing"));
    clear(h);
    expect(h.stops).toEqual([{ lineId }]);
    expect(h.timers[0].cancelled).toBe(true);
    restore(h);
    h.speech.speak(said("next", "t2"));
    expect(h.texts()).toEqual(["playing", "next"]);
  });
});

describe("cancel touches only that task", () => {
  it("keeps another task's line and a notice with no task, and plays them at once", async () => {
    const h = createHarness();
    const lineId = await play(h, said("cancelled task", "t1"));
    h.speech.speak(said("other task", "t2"));
    h.speech.speak(said("notice", null, "notice"));
    h.speech.cancelTask("t1");
    expect(h.stops).toEqual([{ lineId }]);
    expect(h.texts()).toEqual(["cancelled task", "other task"]);
    finish(h, await resolveAndId(h, 1));
    expect(h.texts()).toEqual(["cancelled task", "other task", "notice"]);
  });

  it.each([
    { name: "audio", result: audio() },
    { name: "an unreachable failure", result: failure("unreachable") },
  ])("a cancelled task's late $name has no effect", async ({ result }) => {
    const h = createHarness();
    h.speech.speak(said("first", "t1"));
    h.speech.cancelTask("t1");
    await resolveCall(h, 0, result);
    expect(h.speeches).toEqual([]);
    expect(h.voice).toEqual([]);
  });

  it("a later line for a cancelled task is dropped", () => {
    const h = createHarness();
    h.speech.cancelTask("t1");
    h.speech.speak(said("after cancel", "t1"));
    h.speech.speak(said("other", "t2"));
    expect(h.texts()).toEqual(["other"]);
  });
});

describe("cancel leaves another task's work alone", () => {
  it("another task's synthesis is not aborted and is still sent", async () => {
    const h = createHarness();
    h.speech.speak(said("other", "t2"));
    h.speech.speak(said("cancelled", "t1"));
    h.speech.cancelTask("t1");
    expect(h.calls[0].signal.aborted).toBe(false);
    await resolveCall(h, 0);
    expect(h.speeches).toHaveLength(1);
    expect(h.texts()).toEqual(["other"]);
  });

  it("another task's playing line is not stopped and still holds the queue", async () => {
    const h = createHarness();
    const lineId = await play(h, said("other", "t2"));
    h.speech.speak(said("waiting", "t3"));
    h.speech.cancelTask("t1");
    expect(h.stops).toEqual([]);
    expect(h.timers[0].cancelled).toBe(false);
    expect(h.texts()).toEqual(["other"]);
    finish(h, lineId);
    expect(h.texts()).toEqual(["other", "waiting"]);
  });
});

async function resolveAndId(h: Harness, index: number): Promise<string> {
  await resolveCall(h, index);
  return h.speeches[h.speeches.length - 1].lineId;
}

const lateResults = [
  { name: "audio", result: audio(1) },
  { name: "a voice-down failure", result: failure("noCredit") },
];

describe.each(lateResults)("job ownership: an aborted job's $name", (row) => {
  it("settling while the next job synthesizes leaves that job alone", async () => {
    const h = createHarness();
    h.speech.speak(said("A", "t1"));
    h.speech.cancelTask("t1");
    h.speech.speak(said("B", "t2"));
    await resolveCall(h, 0, row.result);
    expect(h.speeches).toEqual([]);
    expect(h.calls[1].signal.aborted).toBe(false);
    await resolveCall(h, 1, audio(2));
    expect(h.speeches.map((s) => [...new Uint8Array(s.audio)])).toEqual([[2]]);
    expect(h.voice).toEqual([]);
  });

  it("settling while the next line plays leaves that line alone", async () => {
    const h = createHarness();
    h.speech.speak(said("A", "t1"));
    h.speech.cancelTask("t1");
    await play(h, said("B", "t2"));
    h.speech.speak(said("C", "t2"));
    await resolveCall(h, 0, row.result);
    expect(h.speeches).toHaveLength(1);
    expect(h.texts()).toEqual(["A", "B"]);
    expect(h.voice).toEqual([]);
  });

  it("settling before the next job started changes nothing", async () => {
    const h = createHarness();
    h.speech.speak(said("A"));
    h.speech.holdStarted();
    await resolveCall(h, 0, row.result);
    h.speech.holdEnded();
    h.speech.speak(said("B"));
    expect(h.texts()).toEqual(["A", "B"]);
    await resolveCall(h, 1, audio(2));
    expect(h.speeches.map((s) => [...new Uint8Array(s.audio)])).toEqual([[2]]);
    expect(h.voice).toEqual([]);
  });
});
