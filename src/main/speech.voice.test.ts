import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "./speech.harness";
import type { VoiceDownCause } from "./speech";
import {
  audio,
  createHarness,
  failure,
  finish,
  flush,
  resolveCall,
  said,
} from "./speech.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const causes: VoiceDownCause[] = ["unreachable", "keyRejected", "noCredit"];

describe.each(causes)("voice down: %s", (cause) => {
  it("is reported once, the next lines still try, and audio brings voice back", async () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    h.speech.speak(said("third"));
    await resolveCall(h, 0, failure(cause));
    expect(h.voice).toEqual([{ available: false, cause }]);
    expect(h.texts()).toEqual(["first", "second"]);

    await resolveCall(h, 1, failure(cause));
    expect(h.voice).toHaveLength(1);
    expect(h.texts()).toEqual(["first", "second", "third"]);

    await resolveCall(h, 2, audio(3));
    expect(h.voice).toEqual([
      { available: false, cause },
      { available: true, cause: null },
    ]);
    expect(h.speeches).toHaveLength(1);

    finish(h, h.speeches[0].lineId);
    h.speech.speak(said("fourth"));
    await resolveCall(h, 3, failure(cause));
    expect(h.voice).toHaveLength(3);
    expect(h.voice[2]).toEqual({ available: false, cause });
  });

  it("an aborted job's audio does not bring voice back; an owning job's does", async () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    await resolveCall(h, 0, failure(cause));
    h.speech.speak(said("second"));
    h.speech.holdStarted();
    await resolveCall(h, 1, audio());
    expect(h.voice).toEqual([{ available: false, cause }]);

    h.speech.holdEnded();
    h.speech.speak(said("third"));
    await resolveCall(h, 2, audio());
    expect(h.voice[1]).toEqual({ available: true, cause: null });
  });
});

const errorRows: {
  name: string;
  throwsAtOnce: boolean;
  fail: (h: Harness) => Promise<void>;
}[] = [
  {
    name: "a failure with cause error",
    throwsAtOnce: false,
    fail: (h) => resolveCall(h, 0, failure("error")),
  },
  {
    name: "a rejected synthesize",
    throwsAtOnce: false,
    fail: (h) => {
      h.calls[0].reject(new TypeError("socket closed"));
      return flush();
    },
  },
  {
    name: "a synthesize that throws synchronously",
    throwsAtOnce: true,
    fail: () => flush(),
  },
];

describe("synthesis errors", () => {
  it.each(errorRows)(
    "$name drops only that line, with no report",
    async ({ throwsAtOnce, fail }) => {
      const h = createHarness();
      if (throwsAtOnce) {
        h.synthesize.mockImplementationOnce(() => {
          throw new Error("boom");
        });
      }
      h.speech.speak(said("first"));
      h.speech.speak(said("second"));
      await fail(h);
      expect(h.voice).toEqual([]);
      expect(h.speeches).toEqual([]);
      expect(h.texts()).toEqual(
        throwsAtOnce ? ["second"] : ["first", "second"],
      );
      await resolveCall(h, h.calls.length - 1, audio(2));
      expect(h.speeches.map((s) => [...new Uint8Array(s.audio)])).toEqual([
        [2],
      ]);
    },
  );
});
