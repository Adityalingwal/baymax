import { randomBytes } from "node:crypto";
import { connect as netConnect } from "node:net";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closedPort,
  dripRoute,
  htmlPage,
  readablePage,
  sendRoute,
  readThrough,
  startFakeNetwork,
} from "./fake-network";
import type { FakeNetwork, FakeRoute } from "./fake-network";
import type { PageOutcome, ReadLimits } from "./read-page";
import { createWebTool } from "./web-tool";

const gzipped = promisify(gzip);
const brotlied = promisify(brotliCompress);

const html = { "Content-Type": "text/html; charset=utf-8" };
const words = "Plain words for a reader to keep. ";

function htmlRoute(body: string | Buffer, headers = {}): FakeRoute {
  return sendRoute({ headers: { ...html, ...headers }, body });
}

type TextRow = {
  name: string;
  route: () => Promise<FakeRoute>;
  limits?: Partial<ReadLimits>;
  expected: Partial<PageOutcome> & { title?: string; textLength?: number };
};

function okWith(title: string, textLength?: number) {
  return { ok: true, title, textLength } as const;
}

const textRows: TextRow[] = [
  {
    name: "no <title> falls back to the hostname",
    route: async () => htmlRoute(`<p>${words.repeat(5)}</p>`),
    expected: okWith("example.test"),
  },
  {
    name: "a long title is cut to 200 characters",
    route: async () => htmlRoute(htmlPage("t".repeat(300), words.repeat(5))),
    expected: okWith("t".repeat(200)),
  },
  {
    name: "the text is cut to maxChars",
    route: async () => htmlRoute(readablePage),
    limits: { maxChars: 50 },
    expected: okWith("Example page", 50),
  },
  {
    name: "exactly minChars visible characters is enough",
    route: async () => htmlRoute(htmlPage("Short", "abcde fghij")),
    limits: { minChars: 10 },
    expected: okWith("Short", 11),
  },
  {
    name: "a declared charset is decoded",
    route: async () =>
      htmlRoute(Buffer.from(htmlPage("Café", `${words}café`), "latin1"), {
        "Content-Type": "text/html; charset=iso-8859-1",
      }),
    expected: okWith("Café"),
  },
  {
    name: "a gzip body is decoded",
    route: async () =>
      htmlRoute(await gzipped(readablePage), { "Content-Encoding": "gzip" }),
    expected: okWith("Example page"),
  },
  {
    name: "a br body is decoded",
    route: async () =>
      htmlRoute(await brotlied(readablePage), { "Content-Encoding": "br" }),
    expected: okWith("Example page"),
  },
  {
    name: "plain text is read as is",
    route: async () =>
      sendRoute({
        headers: { "Content-Type": "text/plain" },
        body: words.repeat(3),
      }),
    expected: okWith("example.test", words.repeat(3).trim().length),
  },
];

const failureRows: [string, () => Promise<FakeRoute>, PageOutcome][] = [
  [
    "a corrupt gzip body",
    async () => {
      const body = await gzipped(readablePage);
      body.fill(0x41, 12, 40);
      return htmlRoute(body, { "Content-Encoding": "gzip" });
    },
    { ok: false, cause: "noUsableText" },
  ],
  [
    "a gzip-labelled plain body",
    async () => htmlRoute(readablePage, { "Content-Encoding": "gzip" }),
    { ok: false, cause: "noUsableText" },
  ],
  [
    "an unknown content encoding",
    async () => htmlRoute(readablePage, { "Content-Encoding": "deflate" }),
    { ok: false, cause: "noUsableText" },
  ],
  [
    "a JavaScript-only page",
    async () =>
      htmlRoute(
        `<html><body><div id="root"></div><script>${"var app = 1; ".repeat(200)}</script></body></html>`,
      ),
    { ok: false, cause: "noUsableText" },
  ],
  [
    "a 404",
    async () => sendRoute({ status: 404, body: words }),
    { ok: false, cause: "httpError" },
  ],
  [
    "a socket destroyed halfway through a Content-Length body",
    async () => (_req, res) => {
      res.writeHead(200, { ...html, "Content-Length": "10000" });
      res.write(words.repeat(20));
      setTimeout(() => res.socket?.destroy(), 20);
    },
    { ok: false, cause: "unreachable" },
  ],
];

const unreadTypes = ["application/pdf", "application/json"];

let network: FakeNetwork;

beforeEach(async () => {
  network = await startFakeNetwork();
  network.answer("example.test", ["93.184.216.34"]);
});

afterEach(async () => {
  await network.close();
});

function read(
  url: string,
  overrides: Partial<ReadLimits> = {},
  connect = network.connect,
) {
  return readThrough(network, url, { limits: overrides, connect });
}

describe("readPage text", () => {
  it("keeps the title and visible text and sends only the expected headers", async () => {
    network.route(
      "/",
      htmlRoute(
        htmlPage(
          " Example \n page ",
          `<style>.hidden{color:red}</style><script>var secret = 1;</script><h1>Heading</h1><p>${words.repeat(3)}<a href="https://link.test/">a link</a></p>`,
        ),
      ),
    );
    const outcome = await read("http://example.test/");
    if (!outcome.ok) throw new Error(`read failed: ${outcome.cause}`);
    expect(outcome.page.title).toBe("Example page");
    expect(outcome.page.url).toBe("http://example.test/");
    expect(outcome.page.text).toContain("Heading");
    expect(outcome.page.text).toContain("a link");
    expect(outcome.page.text).not.toMatch(/secret|hidden|link\.test/);
    const seen = network.requests[0].headers;
    expect(seen).toMatchObject({
      "user-agent": "Baymax/0.1 (research assistant)",
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      "accept-encoding": "gzip, br",
      "accept-language": "en",
    });
    expect(seen.cookie ?? seen.authorization ?? seen.referer).toBeUndefined();
  });

  it.each(textRows)("$name", async (row) => {
    network.route("/", await row.route());
    const outcome = await read("http://example.test/", row.limits);
    if (!outcome.ok) throw new Error(`read failed: ${outcome.cause}`);
    if (row.expected.title !== undefined) {
      expect(outcome.page.title).toBe(row.expected.title);
    }
    if (row.expected.textLength !== undefined) {
      expect(outcome.page.text).toHaveLength(row.expected.textLength);
    }
  });

  it.each(failureRows)("%s gives no page", async (_name, route, expected) => {
    network.route("/", await route());
    expect(await read("http://example.test/")).toEqual(expected);
  });
});

describe("readPage byte budgets", () => {
  it("stops at maxBytes, keeps the truncated text and closes the socket", async () => {
    const big = dripRoute({
      headers: { "Content-Type": "text/plain" },
      chunk: words.repeat(30),
      everyMs: 5,
      total: 200_000,
    });
    network.route("/", big.route);
    const outcome = await read("http://example.test/", {
      maxBytes: 5_000,
      maxChars: 100_000,
    });
    if (!outcome.ok) throw new Error(`read failed: ${outcome.cause}`);
    expect(outcome.page.text.length).toBeLessThanOrEqual(5_000);
    await vi.waitFor(() => expect(big.closedEarly()).toBe(true));
    expect(big.written()).toBeLessThan(200_000);
  });

  it("keeps at most maxBytes decoded bytes of a gzip bomb", async () => {
    const bomb = await gzipped(Buffer.from(words.repeat(150_000)));
    network.route(
      "/",
      htmlRoute(bomb, {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
      }),
    );
    const outcome = await read("http://example.test/", {
      maxBytes: 20_000,
      maxChars: 1_000_000,
    });
    if (!outcome.ok) throw new Error(`read failed: ${outcome.cause}`);
    expect(bomb.length).toBeLessThan(20_000);
    expect(outcome.page.text.length).toBeGreaterThan(1_000);
    expect(outcome.page.text.length).toBeLessThanOrEqual(20_000);
  });
});

describe("readPage early stops", () => {
  it("keeps what was decoded when a compressed body hits the encoded budget", async () => {
    const noise = await gzipped(randomBytes(50_000));
    network.route(
      "/",
      htmlRoute(noise, {
        "Content-Type": "text/plain",
        "Content-Encoding": "gzip",
      }),
    );
    const outcome = await read("http://example.test/", {
      maxBytes: 5_000,
      maxChars: 100_000,
    });
    if (!outcome.ok) throw new Error(`read failed: ${outcome.cause}`);
    expect(noise.length).toBeGreaterThan(5_000);
    expect(outcome.page.text.length).toBeGreaterThan(1_000);
  });

  it.each(unreadTypes)(
    "refuses to read %s and closes the socket early",
    async (type) => {
      const body = dripRoute({
        headers: { "Content-Type": type },
        chunk: "x".repeat(1_000),
        everyMs: 5,
        total: 200_000,
      });
      network.route("/", body.route);
      expect(await read("http://example.test/")).toEqual({
        ok: false,
        cause: "noUsableText",
      });
      await vi.waitFor(() => expect(body.closedEarly()).toBe(true));
      expect(body.written()).toBeLessThan(200_000);
    },
  );
});

describe("readPage unreachable", () => {
  it("gives unreachable for a name that does not resolve", async () => {
    expect(await read("http://unknown.test/")).toEqual({
      ok: false,
      cause: "unreachable",
    });
  });

  it("gives unreachable for a connection to a closed port", async () => {
    const port = await closedPort();
    const outcome = await read("http://example.test/", {}, () =>
      netConnect(port, "127.0.0.1"),
    );
    expect(outcome).toEqual({ ok: false, cause: "unreachable" });
  });
});

type Compress = (text: string) => Promise<Buffer>;
const encodings: [string, Compress][] = [
  ["gzip", (text) => gzipped(text, { level: 0 })],
  ["br", (text) => brotlied(text)],
];

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
      const outcome = await read("http://example.test/", {
        maxBytes: 20_000,
        maxChars: 100_000,
      });
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
      expect(await read("http://example.test/")).toEqual({
        ok: false,
        cause: "noUsableText",
      });
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
    expect(await read("http://example.test/", { timeoutMs: 2_000 })).toEqual({
      ok: false,
      cause: "httpError",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// The Exa path's own cap: the port cannot set the read limits, so this stays below it.
describe("createWebTool reads through Exa Contents", () => {
  it("keeps Exa's text, collapsed and capped, under the checked URL it asked for", async () => {
    const asked: string[] = [];
    const web = createWebTool({
      search: async () => ({ ok: true, hits: [] }),
      contents: async (url) => {
        asked.push(url);
        return {
          ok: true,
          title: " Exa\n  title ",
          text: `  Exa   text\n\n\n\nfrom its crawler. ${words.repeat(10)}`,
        };
      },
      lookup: network.lookup,
      connect: network.connect,
      limits: { timeoutMs: 5_000, minChars: 20, maxChars: 60 },
    });
    const outcome = await web.read(
      "http://example.test./one#part",
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      ok: true,
      page: {
        id: "s1",
        url: "http://example.test/one",
        title: "Exa title",
        text: "Exa text\n\nfrom its crawler. Plain words for a reader to keep",
      },
    });
    expect(asked).toEqual(["http://example.test/one"]);
    expect(network.targets).toHaveLength(0);
  });
});
