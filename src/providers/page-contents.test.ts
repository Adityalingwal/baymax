import { describe, expect, it } from "vitest";
import { readPageContents } from "./exa";
import type { ContentsOutcome } from "./exa";

const key = "exa-test-key-123";
const never = new AbortController().signal;
const pageUrl = "https://hermes.example/docs";
const longText = "Hermes runs a loop of model calls and tools. ".repeat(10);

type Sent = { url: string; init: RequestInit };
type Reply = (init: RequestInit) => Promise<Response>;

function fakeFetch(reply: Reply) {
  const sent: Sent[] = [];
  const send = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = init ?? {};
    sent.push({ url: String(input), init: request });
    return reply(request);
  };
  return { send, sent };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Reply {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

function untilAborted(): Reply {
  return (init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      });
    });
}

async function contents(reply: Reply, signal = never, timeoutMs = 2_000) {
  const network = fakeFetch(reply);
  const outcome = await readPageContents({
    url: pageUrl,
    key,
    fetch: network.send,
    signal,
    timeoutMs,
  });
  expect(JSON.stringify(outcome)).not.toContain(key);
  return { outcome, sent: network.sent };
}

// The shape Exa sent in the 28 Oct runtime check.
function exaBody(results: unknown[], statuses?: unknown[]) {
  return {
    requestId: "req-1",
    results,
    statuses: statuses ?? [
      { id: pageUrl, status: "success", source: "cached" },
    ],
    costDollars: { total: 0.002, contents: { text: 0.002 } },
    searchTime: 12,
  };
}

const goodResult = {
  id: pageUrl,
  title: "Hermes docs",
  url: pageUrl,
  publishedDate: "2026-10-01",
  text: longText,
};

describe("readPageContents", () => {
  it("posts the URL to Exa Contents with the key only in its header", async () => {
    const { sent } = await contents(json(exaBody([goodResult])));
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent;
    expect(url).toBe("https://api.exa.ai/contents");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": key,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      urls: [pageUrl],
      text: { maxCharacters: 20_000 },
    });
    expect(String(init.body)).not.toContain(key);
  });

  it("returns the matching result's title and text", async () => {
    const other = { ...goodResult, id: "https://other.example/", url: "x" };
    const { outcome } = await contents(
      json(exaBody([other, { ...goodResult, title: "  Hermes docs " }])),
    );
    expect(outcome).toEqual({ ok: true, title: "Hermes docs", text: longText });
  });

  it("matches a result by its url when its id differs", async () => {
    const { outcome } = await contents(
      json(exaBody([{ ...goodResult, id: "exa-1", title: null }])),
    );
    expect(outcome).toEqual({ ok: true, title: "", text: longText });
  });
});

const noTextRows: [string, Reply][] = [
  [
    "an error status for the URL",
    json(
      exaBody(
        [goodResult],
        [
          {
            id: pageUrl,
            status: "error",
            error: { httpStatusCode: 500, tag: "CRAWL_UNKNOWN_ERROR" },
          },
        ],
      ),
    ),
  ],
  ["a missing result", json(exaBody([]))],
  [
    "a result for another URL",
    json(exaBody([{ ...goodResult, id: "a", url: "https://hermes.example/" }])),
  ],
  ["a null status entry", json(exaBody([goodResult], [null]))],
  [
    "a status entry without an id",
    json(exaBody([goodResult], [{ status: "success" }])),
  ],
  [
    "no status for this URL",
    json(exaBody([goodResult], [{ id: "a", status: "success" }])),
  ],
  ["no results field", json({ statuses: [] })],
  ["no statuses field", json({ results: [goodResult] })],
  ["results that are not a list", json({ results: "none", statuses: [] })],
  ["a null body", json(null)],
  ["a result without text", json(exaBody([{ ...goodResult, text: 42 }]))],
  [
    "text under 200 non-space characters",
    json(exaBody([{ ...goodResult, text: `${"a ".repeat(199)}\n\n` }])),
  ],
];

describe("readPageContents finds no usable text", () => {
  it.each(noTextRows)("in %s", async (_name, reply) => {
    const { outcome } = await contents(reply);
    expect(outcome).toEqual({ ok: false, cause: "noUsableText" });
  });
});

const statusRows: [number, ContentsOutcome][] = [
  [401, { ok: false, cause: "keyRejected" }],
  [403, { ok: false, cause: "keyRejected" }],
  [402, { ok: false, cause: "quota" }],
  [429, { ok: false, cause: "quota" }],
  [500, { ok: false, cause: "unreachable" }],
  [503, { ok: false, cause: "unreachable" }],
  [400, { ok: false, cause: "badResponse" }],
  [422, { ok: false, cause: "badResponse" }],
];

describe("readPageContents maps a failing status", () => {
  it.each(statusRows)("%i", async (status, expected) => {
    const { outcome } = await contents(json({ error: `echo ${key}` }, status));
    expect(outcome).toEqual(expected);
  });
});

const badRows: [string, Reply][] = [
  ["a non-JSON body", async () => new Response("<html>oops</html>")],
  [
    "a text that echoes the key",
    json(exaBody([{ ...goodResult, text: `${longText} ${key}` }])),
  ],
  [
    "a title that echoes the key",
    json(exaBody([{ ...goodResult, title: `key ${key}` }])),
  ],
  [
    "a body over 1,000,000 bytes",
    json(exaBody([goodResult]), 200, { "Content-Length": "1000001" }),
  ],
];

describe("readPageContents refuses a bad body", () => {
  it.each(badRows)("%s", async (_name, reply) => {
    const { outcome } = await contents(reply);
    expect(outcome).toEqual({ ok: false, cause: "badResponse" });
  });
});

describe("readPageContents failures without a response", () => {
  it("maps a thrown network error to unreachable", async () => {
    const { outcome } = await contents(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    expect(outcome).toEqual({ ok: false, cause: "unreachable" });
  });

  it("ends at the deadline with timeout", async () => {
    const { outcome } = await contents(untilAborted(), never, 50);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
  });

  it("maps the caller's abort to aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { outcome } = await contents(untilAborted(), controller.signal);
    expect(outcome).toEqual({ ok: false, cause: "aborted" });
  });

  it("sends nothing when the caller has already aborted", async () => {
    const { outcome, sent } = await contents(
      json(exaBody([goodResult])),
      AbortSignal.abort(),
    );
    expect(outcome).toEqual({ ok: false, cause: "aborted" });
    expect(sent).toHaveLength(0);
  });
});
