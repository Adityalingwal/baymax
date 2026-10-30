import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupAll } from "./connection";
import { dripRoute, readThrough, startFakeNetwork } from "./fake-network";
import type { DripRoute, FakeNetwork } from "./fake-network";
import type { PageOutcome } from "./read-page";
import type { RefusalRule } from "./url-rules";

const nonPublicAnswers: [string, string[]][] = [
  ["10.0.0.5", ["10.0.0.5"]],
  ["127.0.0.1", ["127.0.0.1"]],
  ["169.254.169.254", ["169.254.169.254"]],
  ["100.64.0.1", ["100.64.0.1"]],
  ["0.0.0.0", ["0.0.0.0"]],
  ["::1", ["::1"]],
  ["fe80::1", ["fe80::1"]],
  ["fd00::1", ["fd00::1"]],
  ["::ffff:127.0.0.1", ["::ffff:127.0.0.1"]],
  ["::ffff:7f00:1", ["::ffff:7f00:1"]],
  ["64:ff9b::7f00:1", ["64:ff9b::7f00:1"]],
  ["64:ff9b::a00:5", ["64:ff9b::a00:5"]],
  ["64:ff9b::a9fe:a9fe", ["64:ff9b::a9fe:a9fe"]],
  ["64:ff9b:1::14cf:4952", ["64:ff9b:1::14cf:4952"]],
  ["::ffff:14cf:4952", ["::ffff:14cf:4952"]],
  ["2001:2::1", ["2001:2::1"]],
  ["2001:db8::1", ["2001:db8::1"]],
  ["3fff::1", ["3fff::1"]],
  ["a mixed public and private answer", ["93.184.216.34", "10.0.0.5"]],
];

const refusedBeforeLookup: [string, RefusalRule][] = [
  ["http://127.0.0.1/", "privateAddress"],
  ["http://[::1]/", "privateAddress"],
  ["http://169.254.169.254/latest/meta-data", "privateAddress"],
  ["http://0x7f000001/", "privateAddress"],
  ["http://2130706433/", "privateAddress"],
  ["http://127.1/", "privateAddress"],
  ["http://[::ffff:127.0.0.1]/", "privateAddress"],
  ["http://[64:ff9b::7f00:1]/", "privateAddress"],
  ["http://[64:ff9b::127.0.0.1]/", "privateAddress"],
  ["http://localhost/", "blockedHost"],
  ["http://localhost./", "blockedHost"],
  ["http://foo.localhost/", "blockedHost"],
  ["http://printer.local/", "blockedHost"],
  ["https://x.com/a", "blockedHost"],
  ["https://www.linkedin.com/in/a", "blockedHost"],
  ["https://old.reddit.com/r/a", "blockedHost"],
  ["https://api.exa.ai/search", "blockedHost"],
  ["https://api.exa.ai/contents", "blockedHost"],
  ["https://api.exa.ai/answer", "blockedHost"],
  ["HTTPS://API.EXA.AI./contents?x=1", "blockedHost"],
  ["https://x.api.exa.ai/", "blockedHost"],
  ["ftp://example.test/file", "scheme"],
  ["file:///etc/passwd", "scheme"],
  ["javascript:alert(1)", "scheme"],
  ["data:text/html,hi", "scheme"],
  ["not a url", "scheme"],
  ["http://user:pass@example.test/", "credentials"],
];

let network: FakeNetwork;

beforeEach(async () => {
  network = await startFakeNetwork();
  network.answer("example.test", publicAnswer);
});

afterEach(async () => {
  await network.close();
});

function read(url: string) {
  return readThrough(network, url);
}

const exaSitesStillAllowed = [
  "https://exa.ai/",
  "https://docs.exa.ai/reference/search",
  "https://dashboard.exa.ai/",
];

describe("readPage refusals", () => {
  it.each(nonPublicAnswers)(
    "refuses a name resolving to %s without connecting",
    async (_name, addresses) => {
      network.answer("site.test", addresses);
      const outcome = await read("http://site.test/");
      expect(outcome).toEqual({
        ok: false,
        cause: "refused",
        rule: "privateAddress",
      });
      expect(network.lookups).toEqual(["site.test"]);
      expect(network.targets).toEqual([]);
    },
  );

  it.each(refusedBeforeLookup)(
    "refuses %s before any lookup or connection",
    async (url, rule) => {
      const outcome = await read(url);
      expect(outcome).toEqual({ ok: false, cause: "refused", rule });
      expect(network.lookups).toEqual([]);
      expect(network.targets).toEqual([]);
    },
  );

  it.each(exaSitesStillAllowed)(
    "does not refuse the Exa site %s by name",
    async (url) => {
      network.answer(new URL(url).hostname, ["10.0.0.5"]);
      const outcome = await read(url);
      // A public-looking name resolving to a private address proves the URL rules let it through to the lookup.
      expect(outcome).toEqual({
        ok: false,
        cause: "refused",
        rule: "privateAddress",
      });
      expect(network.lookups).toEqual([new URL(url).hostname]);
    },
  );
});

// The deadline tests read example.test with a short timeout and their own signal.
function readTimed(signal: AbortSignal, lookup: LookupAll = network.lookup) {
  return readThrough(network, "http://example.test/", {
    limits: { timeoutMs: 300 },
    lookup,
    signal,
  });
}

const publicAnswer = ["93.184.216.34"];

// A valid gzip stream sent one byte every 50 ms, so only the deadline can end it.
async function gzipDripRoute(): Promise<Omit<DripRoute, "written">> {
  const body = await promisify(gzip)("a".repeat(10_000), { level: 0 });
  let closedEarly = false;
  return {
    route: (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
      });
      let sent = 0;
      const timer = setInterval(() => {
        if (!res.destroyed) res.write(body.subarray(sent, (sent += 1)));
      }, 50);
      res.on("close", () => {
        clearInterval(timer);
        closedEarly = !res.writableFinished;
      });
    },
    closedEarly: () => closedEarly,
  };
}

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

describe("readPage abort before connecting", () => {
  it("returns aborted at once for a signal aborted before the call", async () => {
    const outcome = await readTimed(AbortSignal.abort());
    expect(outcome).toEqual({ ok: false, cause: "aborted" });
    expect(network.lookups).toEqual([]);
    expect(network.targets).toEqual([]);
  });

  it.each(lookupRows)("$name, never connecting", async (row) => {
    const controller = new AbortController();
    if (row.abortAfterMs !== null) {
      setTimeout(() => controller.abort(), row.abortAfterMs);
    }
    expect(await readTimed(controller.signal, row.lookup)).toEqual(
      row.expected,
    );
    await wait(150);
    expect(network.targets).toEqual([]);
  });
});

describe("readPage deadline and mid-body abort", () => {
  it("times out on a server that never answers", async () => {
    network.route("/", () => undefined);
    const outcome = await readTimed(new AbortController().signal);
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
    const outcome = await readTimed(new AbortController().signal);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("times out on a valid gzip body that drips a byte every 50 ms and closes the socket", async () => {
    const drip = await gzipDripRoute();
    network.route("/", drip.route);
    const started = Date.now();
    const outcome = await readTimed(new AbortController().signal);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    await vi.waitFor(() => expect(drip.closedEarly()).toBe(true));
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
    expect(await readTimed(controller.signal)).toEqual({
      ok: false,
      cause: "aborted",
    });
    await vi.waitFor(() => expect(drip.closedEarly()).toBe(true));
  });
});
