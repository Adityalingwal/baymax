import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UtteranceId } from "../shared/cards";
import {
  createHarness,
  failedClip,
  hold,
  missed,
  recorded,
  resolveCall,
  words,
} from "./recording.harness";
import type { Harness } from "./recording.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

type LateRow = {
  name: string;
  finishA: (h: Harness, a: UtteranceId) => Promise<void>;
};

const lateRows: LateRow[] = [
  {
    name: "an empty transcription",
    finishA: (h) => resolveCall(h, 0, { kind: "empty" }),
  },
  {
    name: "a failed transcription",
    finishA: (h) =>
      resolveCall(h, 0, { kind: "failed", cause: "error", detail: "500" }),
  },
];

describe("late not caught", () => {
  it.each(lateRows)(
    "drops A's not-caught from $name after B's words",
    async ({ finishA }) => {
      const h = createHarness();
      const a = hold(h, "accept");
      h.flow.clipArrived(recorded(a));
      const b = hold(h, "accept");
      h.flow.clipArrived(recorded(b));
      await resolveCall(h, 1, { kind: "words", words: "newer" });
      await finishA(h, a);
      expect(h.heard).toEqual([words(b, "newer")]);
    },
  );

  it("drops a failed clip that arrives after a newer question's words", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    await resolveCall(h, 0, { kind: "words", words: "newer" });
    h.flow.clipArrived(failedClip(a, "noMicrophone"));
    expect(h.heard).toEqual([words(b, "newer")]);
  });
});

describe("late transcript", () => {
  it("drops an older transcript that resolves after a newer question's words", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    await resolveCall(h, 1, { kind: "words", words: "second" });
    await resolveCall(h, 0, { kind: "words", words: "first" });
    expect(h.heard).toEqual([words(b, "second")]);
  });

  it("delivers both in order when the older resolves first", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    await resolveCall(h, 0, { kind: "words", words: "first" });
    await resolveCall(h, 1, { kind: "words", words: "second" });
    expect(h.heard).toEqual([words(a, "first"), words(b, "second")]);
  });

  it("orders by hold, not by clip arrival", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    h.flow.clipArrived(recorded(a));
    await resolveCall(h, 1, { kind: "words", words: "first" });
    await resolveCall(h, 0, { kind: "words", words: "second" });
    expect(h.heard).toEqual([words(a, "first"), words(b, "second")]);
  });
});

describe("what never makes a question late", () => {
  it("keeps A when a discarded tap and a not-caught B come between A and its result", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    const tap = hold(h, "discard");
    h.flow.clipArrived(recorded(tap));
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b, 0));
    await resolveCall(h, 0, { kind: "words", words: "question" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([missed(b, "empty"), words(a, "question")]);
  });
});

describe("renderer reset", () => {
  it("still delivers a transcription already in flight", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    h.flow.rendererReset();
    await resolveCall(h, 0, { kind: "words", words: "kept" });
    expect(h.heard).toEqual([words(a, "kept")]);
  });

  it("keeps the sequence, so a newer question's words make an older in-flight result late", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    h.flow.rendererReset();
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    await resolveCall(h, 1, { kind: "words", words: "newer" });
    await resolveCall(h, 0, { kind: "words", words: "older" });
    expect(h.heard).toEqual([words(b, "newer")]);
  });
});

describe("duplicate clip while transcribing", () => {
  it("calls transcribe once", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    h.flow.clipArrived(recorded(a));
    await resolveCall(h, 0, { kind: "words", words: "once" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([words(a, "once")]);
  });
});
