import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentsFn, ContentsOutcome } from "../../src/providers/exa";
import {
  closeRuns,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeRuns();
});

const oneCited = { report: "Hermes runs a loop.", sourceIds: ["s1"] };

const steps = () => [
  toolUseReply([{ search: "hermes" }]),
  toolUseReply([{ read: pageUrl("one") }, { read: pageUrl("missing") }]),
  workerAnswer(oneCited),
];

describe("runTask page reads in tests", () => {
  it("send every read to the fake Exa Contents and never to the real fetch", async () => {
    const realFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("a test reached the real network"));
    const run = await startRun(steps(), [hits(pageUrl("one"))]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({ type: "result" });
    expect([...run.contentsAsked].sort()).toEqual(
      [pageUrl("missing"), pageUrl("one")].sort(),
    );
    expect(realFetch).not.toHaveBeenCalled();
  });
});

const exaText = "Exa read this page with its own crawler. ".repeat(8);

describe("runTask with Exa Contents", () => {
  it("gives the worker Exa's text and reads nothing itself", async () => {
    const contents: ContentsFn = async () => ({
      ok: true,
      title: "Hermes from Exa",
      text: exaText,
    });
    const run = await startRun(steps().slice(1), [], undefined, contents);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({
      type: "result",
      findings: {
        sources: [{ id: "s1", url: pageUrl("one"), title: "Hermes from Exa" }],
      },
    });
    const results = JSON.stringify(run.requests[1].messages[2].content);
    expect(results).toContain("Exa read this page with its own crawler.");
    expect(run.network.targets).toHaveLength(0);
  });
});

const nothing = {
  report: "",
  line: "",
  sourceIds: [],
  nothingFound: "Little found.",
};
const readEntries = (entries: { event: string; tool?: string }[]) =>
  entries.filter(
    (entry) => entry.event === "toolCall" && entry.tool === "read",
  );

const refusedRows: { url: string; logged: Record<string, string> }[] = [
  ...[
    "http://localhost/",
    "http://printer.local/",
    "http://10.0.0.1/",
    "http://[::1]/",
    "http://user:pass@example.test/one",
    "https://x.com/someone",
    "ftp://example.test/one",
  ].map((url) => ({ url, logged: { outcome: "refused" } })),
  {
    url: "https://api.exa.ai/contents",
    logged: { outcome: "refused", host: "api.exa.ai", rule: "blockedHost" },
  },
];

describe("runTask refused reads", () => {
  it.each(refusedRows)(
    "never sends the refused URL $url to Exa or the reader",
    async ({ url, logged }) => {
      const run = await startRun([
        toolUseReply([{ read: url }]),
        workerAnswer(nothing),
      ]);
      run.port.send(runTask());
      await run.ended();
      expect(readEntries(run.entries)).toEqual([
        expect.objectContaining({ tool: "read", ...logged }),
      ]);
      expect(run.contentsAsked).toHaveLength(0);
      expect(run.network.targets).toHaveLength(0);
    },
  );
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

describe("runTask falls back to its own reader", () => {
  it.each(fallbackRows)("after Exa gives %s", async (_name, outcome) => {
    const run = await startRun(
      [toolUseReply([{ read: pageUrl("one") }]), workerAnswer(oneCited)],
      [],
      undefined,
      async () => outcome,
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({
      type: "result",
      findings: {
        sources: [{ id: "s1", url: pageUrl("one"), title: "Page one" }],
      },
    });
    expect(run.contentsAsked).toHaveLength(1);
    expect(run.network.targets).toHaveLength(1);
  });
});
