import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./playback.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("a streamed line (L10b)", () => {
  it("queues its chunks in seq order and reports ended once, after its end and the last chunk played", () => {
    const h = createHarness();
    h.chunk("a", 0);
    h.chunk("a", 1);
    expect(h.queued).toEqual([1, 2]);
    h.drain();
    expect(h.reports).toEqual([]);
    h.end("a");
    expect(h.reports).toEqual([]);
    h.drain();
    h.drain();
    expect(h.reports).toEqual([{ lineId: "a", outcome: "ended" }]);
  });

  it("ignores a chunk out of seq order, and a new line that does not start at seq 0", () => {
    const h = createHarness();
    h.chunk("a", 1);
    h.chunk("a", 0);
    h.chunk("a", 2);
    h.chunk("a", 1);
    expect(h.queued).toEqual([1, 2]);
  });

  it("reports a line with no audio ended at its end", () => {
    const h = createHarness();
    h.end("a");
    h.end("a");
    expect(h.reports).toEqual([{ lineId: "a", outcome: "ended" }]);
  });
});

describe("stopping a streamed line (L10b)", () => {
  it("a stop stops the player, reports stopped once and ignores the line's later chunks and end", () => {
    const h = createHarness();
    h.chunk("a", 0);
    h.stopLine("a");
    h.chunk("a", 1);
    h.end("a");
    h.drain();
    expect(h.player.stop).toHaveBeenCalledTimes(1);
    expect(h.queued).toEqual([1]);
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
  });

  it("ignores the chunks of a line told to stop before its audio came", () => {
    const h = createHarness();
    h.stopLine("a");
    h.chunk("a", 0);
    expect(h.queued).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  it("a whole clip while a line streams stops the stream first", () => {
    const h = createHarness();
    h.chunk("a", 0);
    h.speak("b");
    expect(h.reports).toEqual([{ lineId: "a", outcome: "stopped" }]);
    expect(h.plays).toHaveLength(1);
  });
});
