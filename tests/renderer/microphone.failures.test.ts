import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, flush, resolveStream } from "./microphone.harness";

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
      expect(h.seen()).toEqual([]);
      h.stop("a");
      expect(h.seen()).toEqual([`a failed ${reason}`]);
    },
  );

  it("a synchronous getUserMedia throw sends failed error after the stop", async () => {
    const h = createHarness("getUserMediaThrows");
    expect(() => h.start("a")).not.toThrow();
    await flush();
    expect(h.seen()).toEqual([]);
    h.stop("a");
    expect(h.seen()).toEqual(["a failed error"]);
  });
});

describe("microphone capture failures", () => {
  it("a capture that cannot start stops the tracks and sends failed error after the stop", async () => {
    const h = createHarness();
    h.start("a");
    await resolveStream(h, 0);
    h.captures[0].reject(new DOMException("no worklet", "AbortError"));
    await flush();
    expect(h.streams[0].stopTrack).toHaveBeenCalled();
    expect(h.seen()).toEqual([]);
    h.stop("a");
    expect(h.seen()).toEqual(["a failed error"]);
  });
});
