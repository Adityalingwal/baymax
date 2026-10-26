import { setTimeout as wait } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupAll } from "./connection";
import { dripRoute, startFakeNetwork } from "./fake-network";
import type { FakeNetwork } from "./fake-network";
import { readPage } from "./read-page";
import type { PageOutcome, ReadLimits } from "./read-page";

const limits: ReadLimits = {
  maxBytes: 100_000,
  timeoutMs: 300,
  maxRedirects: 5,
  maxChars: 8_000,
  minChars: 20,
};

const publicAnswer = ["93.184.216.34"];

type LookupRow = {
  name: string;
  lookup: LookupAll;
  abortAfterMs: number | null;
  expected: PageOutcome;
};

const lookupRows: LookupRow[] = [
  {
    name: "a lookup that never settles ends at the deadline",
    lookup: () => new Promise<string[]>(() => undefined),
    abortAfterMs: null,
    expected: { ok: false, cause: "timeout" },
  },
  {
    name: "a lookup that resolves after the caller aborted",
    lookup: () => wait(100, publicAnswer),
    abortAfterMs: 20,
    expected: { ok: false, cause: "aborted" },
  },
  {
    name: "a lookup that rejects after the caller aborted",
    lookup: async () => {
      await wait(100);
      throw new Error("lookup failed late");
    },
    abortAfterMs: 20,
    expected: { ok: false, cause: "aborted" },
  },
];

let network: FakeNetwork;

beforeEach(async () => {
  network = await startFakeNetwork();
  network.answer("example.test", publicAnswer);
});

afterEach(async () => {
  await network.close();
});

function read(signal: AbortSignal, lookup: LookupAll = network.lookup) {
  return readPage(
    "http://example.test/",
    { lookup, connect: network.connect, limits },
    signal,
  );
}

describe("readPage abort before connecting", () => {
  it("returns aborted at once for a signal aborted before the call", async () => {
    const outcome = await read(AbortSignal.abort());
    expect(outcome).toEqual({ ok: false, cause: "aborted" });
    expect(network.lookups).toEqual([]);
    expect(network.targets).toEqual([]);
  });

  it.each(lookupRows)("$name, never connecting", async (row) => {
    const controller = new AbortController();
    if (row.abortAfterMs !== null) {
      setTimeout(() => controller.abort(), row.abortAfterMs);
    }
    expect(await read(controller.signal, row.lookup)).toEqual(row.expected);
    await wait(150);
    expect(network.targets).toEqual([]);
  });
});

describe("readPage deadline and mid-body abort", () => {
  it("times out on a server that never answers", async () => {
    network.route("/", () => undefined);
    const outcome = await read(new AbortController().signal);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
  });

  it("times out on a server that drips a byte every 50 ms", async () => {
    const drip = dripRoute({
      headers: { "Content-Type": "text/plain" },
      chunk: "a",
      everyMs: 50,
    });
    network.route("/", drip.route);
    const started = Date.now();
    const outcome = await read(new AbortController().signal);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns aborted when the caller aborts mid-body and closes the socket", async () => {
    const drip = dripRoute({
      headers: { "Content-Type": "text/plain" },
      chunk: "words ",
      everyMs: 10,
    });
    network.route("/", drip.route);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    expect(await read(controller.signal)).toEqual({
      ok: false,
      cause: "aborted",
    });
    await vi.waitFor(() => expect(drip.closedEarly()).toBe(true));
  });
});
