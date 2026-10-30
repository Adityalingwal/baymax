import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContentsFn, ContentsOutcome } from "../../../providers/exa";
import { htmlPage, sendRoute, startFakeNetwork } from "./fake-network";
import type { FakeNetwork } from "./fake-network";
import { createWebTool } from "./web-tool";

const words = "Plain words for a reader to keep. ";
const hostedText = `  Exa   text\n\n\n\nfrom its crawler. ${words.repeat(10)}`;
const signal = new AbortController().signal;

let network: FakeNetwork;

beforeEach(async () => {
  network = await startFakeNetwork();
  network.answer("example.test", ["93.184.216.34"]);
  network.route(
    "/one",
    sendRoute({
      headers: { "Content-Type": "text/html" },
      body: htmlPage("Page /one", `<p>${words.repeat(10)}</p>`),
    }),
  );
  network.route("/missing", sendRoute({ status: 404 }));
});

afterEach(async () => {
  await network.close();
});

// Records every URL sent to Exa Contents and answers each with the given reply.
function hosted(reply: ContentsFn) {
  const asked: string[] = [];
  const contents: ContentsFn = (url, callSignal) => {
    asked.push(url);
    return reply(url, callSignal);
  };
  const web = createWebTool({
    search: async () => ({ ok: true, hits: [] }),
    contents,
    lookup: network.lookup,
    connect: network.connect,
    limits: { timeoutMs: 5_000, minChars: 20, maxChars: 60 },
  });
  return { web, asked };
}

const answer =
  (outcome: ContentsOutcome): ContentsFn =>
  async () =>
    outcome;

// Answers only once the call is aborted, a few turns later, as a real request stops.
const untilAborted: ContentsFn = (_url, callSignal) =>
  new Promise((resolve) => {
    callSignal.addEventListener(
      "abort",
      () => setTimeout(() => resolve({ ok: false, cause: "aborted" }), 5),
      { once: true },
    );
  });

describe("createWebTool reads through Exa Contents", () => {
  it("keeps Exa's text, collapsed and capped, under the checked URL it asked for", async () => {
    const { web, asked } = hosted(
      answer({ ok: true, title: " Exa\n  title ", text: hostedText }),
    );
    const outcome = await web.read("http://example.test./one#part", signal);
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

  it("titles a page by its hostname when Exa gives no title", async () => {
    const { web } = hosted(answer({ ok: true, title: "", text: hostedText }));
    const outcome = await web.read("http://example.test/one", signal);
    expect(outcome).toMatchObject({
      ok: true,
      page: { title: "example.test" },
    });
  });
});

const fallbackRows: [string, ContentsOutcome][] = [
  ["no usable text", { ok: false, cause: "noUsableText" }],
  ["text too short", { ok: true, title: "Short", text: "tiny" }],
  ["unreachable", { ok: false, cause: "unreachable" }],
  ["timeout", { ok: false, cause: "timeout" }],
  ["a rejected key", { ok: false, cause: "keyRejected" }],
  ["quota", { ok: false, cause: "quota" }],
  ["a bad response", { ok: false, cause: "badResponse" }],
];

describe("createWebTool falls back to its own reader", () => {
  it.each(fallbackRows)("after Exa gives %s", async (_name, outcome) => {
    const { web, asked } = hosted(answer(outcome));
    const read = await web.read("http://example.test/one", signal);
    expect(read).toMatchObject({
      ok: true,
      page: { id: "s1", url: "http://example.test/one", title: "Page /one" },
    });
    expect(asked).toHaveLength(1);
    expect(network.targets).toHaveLength(1);
  });

  it("returns the fallback reader's failure when both fail", async () => {
    const { web } = hosted(answer({ ok: false, cause: "unreachable" }));
    const read = await web.read("http://example.test/missing", signal);
    expect(read).toEqual({ ok: false, cause: "httpError" });
    expect(web.pages()).toHaveLength(0);
  });
});

describe("createWebTool around Exa Contents", () => {
  it("starts no fallback once the read is aborted during the Exa call", async () => {
    const { web, asked } = hosted(untilAborted);
    const caller = new AbortController();
    const read = web.read("http://example.test/one", caller.signal);
    caller.abort();
    expect(await read).toEqual({ ok: false, cause: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toHaveLength(1);
    expect(network.lookups).toHaveLength(0);
    expect(network.targets).toHaveLength(0);
  });

  it.each([
    "http://localhost/",
    "http://printer.local/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://user:pass@example.test/one",
    "https://x.com/someone",
    "ftp://example.test/one",
  ])("never sends the refused URL %s to Exa", async (url) => {
    const { web, asked } = hosted(answer({ ok: false, cause: "unreachable" }));
    expect(await web.read(url, signal)).toMatchObject({ cause: "refused" });
    expect(asked).toHaveLength(0);
  });

  it("refuses Exa's API host as blockedHost and never calls Exa Contents", async () => {
    const { web, asked } = hosted(answer({ ok: false, cause: "unreachable" }));
    expect(await web.read("https://api.exa.ai/contents", signal)).toEqual({
      ok: false,
      cause: "refused",
      rule: "blockedHost",
    });
    expect(asked).toHaveLength(0);
  });

  it("shares one Exa call between two reads of one URL started together", async () => {
    const { web, asked } = hosted(
      answer({ ok: true, title: "Exa title", text: hostedText }),
    );
    const [first, second] = await Promise.all([
      web.read("http://example.test/one", signal),
      web.read("http://example.test/one", signal),
    ]);
    expect(first).toMatchObject({ ok: true, page: { id: "s1" } });
    expect(second).toEqual(first);
    expect(asked).toHaveLength(1);
  });
});
