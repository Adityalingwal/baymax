import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendRoute, startFakeNetwork, testLimits } from "./fake-network";
import type { FakeNetwork, FakeRoute } from "./fake-network";
import { readPage } from "./read-page";
import type { ReadLimits } from "./read-page";

const gzipped = promisify(gzip);
const brotlied = promisify(brotliCompress);
const words = "Plain words for a reader to keep. ";

type Compress = (text: string) => Promise<Buffer>;
const encodings: [string, Compress][] = [
  ["gzip", (text) => gzipped(text, { level: 0 })],
  ["br", (text) => brotlied(text)],
];

let network: FakeNetwork;

beforeEach(async () => {
  network = await startFakeNetwork();
  network.answer("example.test", ["93.184.216.34"]);
});

afterEach(async () => {
  await network.close();
});

function read(overrides: Partial<ReadLimits> = {}) {
  return readPage(
    "http://example.test/",
    {
      lookup: network.lookup,
      connect: network.connect,
      limits: { ...testLimits, ...overrides },
    },
    new AbortController().signal,
  );
}

// Sends the body in 4 KB pieces, so the reader meets the encoded budget mid-stream.
function streamedRoute(body: Buffer, encoding: string): FakeRoute {
  return (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Encoding": encoding,
    });
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return;
      if (sent >= body.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(body.subarray(sent, (sent += 4_096)));
    }, 5);
    res.on("close", () => clearInterval(timer));
  };
}

describe("readPage compressed streams", () => {
  it.each(encodings)(
    "keeps what was decoded when a streamed %s body meets the encoded budget",
    async (encoding, compress) => {
      // Random base64 barely compresses, so the encoded body really exceeds the budget.
      const text = randomBytes(150_000).toString("base64");
      const body = await compress(text);
      expect(body.length).toBeGreaterThan(20_000);
      network.route("/", streamedRoute(body, encoding));
      const outcome = await read({ maxBytes: 20_000, maxChars: 100_000 });
      if (!outcome.ok) throw new Error(`read failed: ${outcome.cause}`);
      expect(outcome.page.text.length).toBeGreaterThan(1_000);
      expect(text.startsWith(outcome.page.text.slice(0, 100))).toBe(true);
    },
  );

  it.each(encodings)(
    "refuses a %s body that ends early within the budget",
    async (encoding, compress) => {
      const whole = await compress(words.repeat(100));
      const body = whole.subarray(0, whole.length - 8);
      network.route(
        "/",
        sendRoute({
          headers: {
            "Content-Type": "text/plain",
            "Content-Encoding": encoding,
          },
          body,
        }),
      );
      expect(await read()).toEqual({ ok: false, cause: "noUsableText" });
    },
  );
});

describe("readPage protocol upgrades", () => {
  it("ends a 101 response as an HTTP error before the deadline", async () => {
    network.route("/", (req) => {
      req.socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: other\r\n\r\n",
      );
    });
    const started = Date.now();
    expect(await read({ timeoutMs: 2_000 })).toEqual({
      ok: false,
      cause: "httpError",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
