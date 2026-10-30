import { describe, expect, it } from "vitest";
import { searchWeb } from "./exa";
import type { SearchOutcome } from "./exa";

const key = "exa-test-key-123";
const never = new AbortController().signal;

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

function json(body: unknown, status = 200): Reply {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
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

async function search(reply: Reply, signal = never, timeoutMs = 2_000) {
  const network = fakeFetch(reply);
  const outcome = await searchWeb({
    query: "hermes agent",
    key,
    fetch: network.send,
    signal,
    timeoutMs,
  });
  expect(JSON.stringify(outcome)).not.toContain(key);
  return { outcome, sent: network.sent };
}

const goodBody = {
  results: [
    {
      url: "https://hermes.example/docs",
      title: "Hermes docs",
      highlights: ["The loop  runs\n tools.", "It keeps memory."],
    },
    { url: "https://blog.example/post", title: null },
    {
      url: "https://long.example/",
      title: "Long",
      highlights: ["x".repeat(900)],
    },
  ],
};

describe("searchWeb", () => {
  it("posts the query to Exa with the key only in its header", async () => {
    const { sent } = await search(json(goodBody));
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent;
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": key,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      query: "hermes agent",
      numResults: 5,
      type: "lite",
      contents: { highlights: { maxCharacters: 500 } },
    });
    expect(String(init.body)).not.toContain(key);
  });

  it("maps a good body to hits with trimmed snippets", async () => {
    const { outcome } = await search(json(goodBody));
    expect(outcome).toEqual({
      ok: true,
      hits: [
        {
          url: "https://hermes.example/docs",
          title: "Hermes docs",
          snippet: "The loop runs tools. … It keeps memory.",
        },
        {
          url: "https://blog.example/post",
          title: "https://blog.example/post",
          snippet: "",
        },
        {
          url: "https://long.example/",
          title: "Long",
          snippet: "x".repeat(500),
        },
      ],
    });
  });
});

const statusRows: [number, SearchOutcome][] = [
  [401, { ok: false, cause: "keyRejected" }],
  [403, { ok: false, cause: "keyRejected" }],
  [402, { ok: false, cause: "quota" }],
  [429, { ok: false, cause: "quota" }],
  [500, { ok: false, cause: "unreachable" }],
  [503, { ok: false, cause: "unreachable" }],
  [400, { ok: false, cause: "badResponse" }],
  [422, { ok: false, cause: "badResponse" }],
];

describe("searchWeb maps a failing status", () => {
  it.each(statusRows)("%i", async (status, expected) => {
    const { outcome } = await search(json({ error: `echo ${key}` }, status));
    expect(outcome).toEqual(expected);
  });
});

const badBodyRows: [string, Reply][] = [
  ["a non-JSON body", async () => new Response("<html>oops</html>")],
  ["no results field", json({ hits: [] })],
  ["results that are not a list", json({ results: "none" })],
  ["a hit without a url", json({ results: [{ title: "No url" }] })],
  ["a null body", json(null)],
  [
    "a hit that echoes the key",
    json({ results: [{ url: "https://x.example/", title: `key ${key}` }] }),
  ],
];

describe("searchWeb refuses a wrongly shaped body", () => {
  it.each(badBodyRows)("%s", async (_name, reply) => {
    const { outcome } = await search(reply);
    expect(outcome).toEqual({ ok: false, cause: "badResponse" });
  });
});

describe("searchWeb failures without a response", () => {
  it("maps a thrown network error to unreachable", async () => {
    const { outcome } = await search(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    expect(outcome).toEqual({ ok: false, cause: "unreachable" });
  });

  it("ends at the deadline with timeout", async () => {
    const { outcome } = await search(untilAborted(), never, 50);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
  });

  it("maps the caller's abort to aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { outcome } = await search(untilAborted(), controller.signal);
    expect(outcome).toEqual({ ok: false, cause: "aborted" });
  });

  it("sends nothing when the caller has already aborted", async () => {
    const { outcome, sent } = await search(json(goodBody), AbortSignal.abort());
    expect(outcome).toEqual({ ok: false, cause: "aborted" });
    expect(sent).toHaveLength(0);
  });
});

describe("searchWeb picks the signal that fired first", () => {
  it("keeps timeout when the caller aborts after the deadline", async () => {
    const controller = new AbortController();
    const reply: Reply = (init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          controller.abort();
          setTimeout(() => reject(init.signal?.reason), 10);
        });
      });
    const { outcome } = await search(reply, controller.signal, 50);
    expect(outcome).toEqual({ ok: false, cause: "timeout" });
  });

  it("maps a caller abort while the body is read to aborted", async () => {
    const controller = new AbortController();
    const reply: Reply = async (init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"results":'));
          init.signal?.addEventListener("abort", () => {
            stream.error(init.signal?.reason);
          });
          setTimeout(() => controller.abort(), 20);
        },
      });
      return new Response(body);
    };
    const { outcome } = await search(reply, controller.signal);
    expect(outcome).toEqual({ ok: false, cause: "aborted" });
  });
});
