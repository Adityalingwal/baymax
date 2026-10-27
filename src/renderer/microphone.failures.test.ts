import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  failedError,
  flush,
  resolveStream,
} from "./microphone.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

type FailureRow = { name: string; error: string; reason: string };

const failureRows: FailureRow[] = [
  {
    name: "NotAllowedError",
    error: "NotAllowedError",
    reason: "permissionDenied",
  },
  { name: "SecurityError", error: "SecurityError", reason: "permissionDenied" },
  { name: "NotFoundError", error: "NotFoundError", reason: "noMicrophone" },
  {
    name: "OverconstrainedError",
    error: "OverconstrainedError",
    reason: "noMicrophone",
  },
  { name: "AbortError", error: "AbortError", reason: "error" },
];

describe("microphone stream failures", () => {
  it.each(failureRows)(
    "getUserMedia rejecting with $name sends failed $reason, only after the stop",
    async ({ error, reason }) => {
      const h = createHarness();
      h.start("a");
      h.streams[0].reject(new DOMException("denied", error));
      await flush();
      expect(h.clips).toEqual([]);
      h.stop("a");
      expect(h.clips).toEqual([
        { utteranceId: "a", outcome: "failed", reason },
      ]);
    },
  );
});

describe("microphone recorder failures", () => {
  it.each(["create", "start"] as const)(
    "the recorder's %s throwing sends a failed error clip after the stop and stops the tracks",
    async (breakage) => {
      const h = createHarness(breakage);
      h.start("a");
      await resolveStream(h, 0);
      expect(h.streams[0].stopTrack).toHaveBeenCalled();
      expect(h.clips).toEqual([]);
      h.stop("a");
      expect(h.clips).toEqual([failedError("a")]);
    },
  );

  it("the recorder's stop throwing sends a failed error clip at once and stops the tracks", async () => {
    const h = createHarness("stop");
    h.start("a");
    await resolveStream(h, 0);
    h.stop("a");
    expect(h.clips).toEqual([failedError("a")]);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
  });

  it("a synchronous getUserMedia throw sends a failed error clip after the stop", async () => {
    const h = createHarness("getUserMediaThrows");
    expect(() => h.start("a")).not.toThrow();
    await flush();
    expect(h.clips).toEqual([]);
    h.stop("a");
    expect(h.clips).toEqual([failedError("a")]);
  });
});

describe("microphone failures once recording runs", () => {
  it("reading the blob failing sends a failed error clip once", async () => {
    const h = createHarness();
    const read = vi
      .spyOn(Blob.prototype, "arrayBuffer")
      .mockRejectedValueOnce(new DOMException("gone", "NotReadableError"));
    h.start("a");
    await resolveStream(h, 0);
    h.stop("a");
    h.recorders[0].emitStop();
    await flush();
    expect(h.clips).toEqual([failedError("a")]);
    read.mockRestore();
  });

  it("a recorder that stops on its own sends nothing until main's stop, then a failed error clip", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.recorders[0].emitStop();
    await flush();
    expect(h.clips).toEqual([]);
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    h.stop("a");
    expect(h.clips).toEqual([failedError("a")]);
  });

  it("the recorder's error sends a failed error clip after the stop, once", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.recorders[0].emitError();
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.clips).toEqual([]);
    h.stop("a");
    h.recorders[0].emitStop();
    await flush();
    expect(h.clips).toEqual([
      { utteranceId: "a", outcome: "failed", reason: "error" },
    ]);
  });
});
