import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeNetwork } from "./fake-network";
import type { FakeNetwork } from "./fake-network";
import { readPage } from "./read-page";
import type { ReadLimits } from "./read-page";
import type { RefusalRule } from "./url-rules";

const limits: ReadLimits = {
  maxBytes: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  maxChars: 8_000,
  minChars: 20,
};

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
  ["http://localhost/", "blockedHost"],
  ["http://localhost./", "blockedHost"],
  ["http://foo.localhost/", "blockedHost"],
  ["http://printer.local/", "blockedHost"],
  ["https://x.com/a", "blockedHost"],
  ["https://www.linkedin.com/in/a", "blockedHost"],
  ["https://old.reddit.com/r/a", "blockedHost"],
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
});

afterEach(async () => {
  await network.close();
});

function read(url: string) {
  return readPage(
    url,
    { lookup: network.lookup, connect: network.connect, limits },
    new AbortController().signal,
  );
}

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
});
