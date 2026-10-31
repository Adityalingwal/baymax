import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOutcome, ModelRequest } from "../../src/providers/anthropic";
import type { SearchOutcome } from "../../src/providers/exa";
import type { EngineEvent } from "../../src/shared/engine";
import { startEngine } from "../../src/engine/index";
import { fakeMessage } from "./harness";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  endTurnWith,
  failed,
  goodAnswer,
  hits,
  pageUrl,
  runTask,
  startRun,
  textBlock,
  thinkingBlock,
  toolUseReply,
  until,
  workerAnswer,
} from "./run.harness";
import type { FakeSearchStep } from "./run.harness";

afterEach(closeRuns);

const errorEnd = failed("error");
const searchDown = failed("searchDown");
const keyRejected = failed("searchKeyRejected");
const modelError: ModelOutcome = { ok: false, failure: "error", detail: "x" };

async function runOf(steps: FakeStep[], searches: FakeSearchStep[] = []) {
  const run = await startRun(steps, searches);
  run.port.send(runTask());
  const events = await run.ended();
  const last = events.filter((event) => event.type !== "progress");
  return { run, last };
}

function lastResults(request: ModelRequest): unknown {
  return request.messages[request.messages.length - 1].content;
}

const searchFailed = (cause: string): SearchOutcome =>
  ({ ok: false, cause }) as SearchOutcome;

describe("runTask search endings", () => {
  it.each([
    { cause: "keyRejected", ending: "searchKeyRejected" },
    { cause: "quota", ending: "searchQuota" },
  ] as const)("ends $ending at once on $cause", async ({ cause, ending }) => {
    const { run, last } = await runOf(
      [toolUseReply([{ search: "hermes" }])],
      [searchFailed(cause)],
    );
    expect(last).toEqual([failed(ending)]);
    expect(run.requests).toHaveLength(1);
  });

  it("tells the worker about one failed search and goes on", async () => {
    const { run, last } = await runOf(
      [toolUseReply([{ search: "hermes" }]), modelError],
      [searchFailed("timeout")],
    );
    expect(last).toEqual([errorEnd]);
    expect(lastResults(run.requests[1])).toEqual([
      expect.objectContaining({
        is_error: true,
        content: expect.stringContaining("Search failed (timeout)"),
      }),
    ]);
  });
});

const searchKey = "secret-search-key";

// The real search call with only the network faked: the reply echoes the key, as a provider's error text may.
describe("a search provider's refusal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { status: 401, cause: "searchKeyRejected" },
    { status: 429, cause: "searchQuota" },
  ] as const)("$status names $cause and carries no key text", async (row) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(`bad key ${searchKey}`, { status: row.status }),
    );
    const events: EngineEvent[] = [];
    const port = startEngine(
      { anthropicKey: "test-key", searchKey },
      {
        model: async () => toolUseReply([{ search: "hermes" }]),
        log: () => undefined,
      },
    );
    port.onMessage((event) => events.push(event));
    port.send(runTask());
    await until(() => events.some((event) => event.type === "failed"));
    port.close();
    expect(events.at(-1)).toEqual(failed(row.cause));
    expect(JSON.stringify(events)).not.toContain(searchKey);
    expect(JSON.stringify(events)).not.toContain("bad key");
  });
});

describe("runTask search limits", () => {
  it("goes on after a search fails, one succeeds and one fails again", async () => {
    const { run, last } = await runOf(
      [
        toolUseReply([{ search: "hermes" }]),
        toolUseReply([{ search: "hermes agent" }]),
        toolUseReply([{ search: "hermes loop" }]),
        toolUseReply([{ read: pageUrl("one") }]),
        workerAnswer({ sourceIds: ["s1"] }),
      ],
      [searchFailed("timeout"), hits(pageUrl("one")), searchFailed("timeout")],
    );
    expect(last).toEqual([expect.objectContaining({ type: "result" })]);
    expect(run.queries).toHaveLength(3);
  });

  it("ends searchDown on the second failed search in a row", async () => {
    const { run, last } = await runOf(
      [
        toolUseReply([{ search: "hermes" }]),
        toolUseReply([{ search: "hermes agent" }]),
      ],
      [searchFailed("timeout"), searchFailed("unreachable")],
    );
    expect(last).toEqual([searchDown]);
    expect(run.queries).toHaveLength(2);
  });
});

describe("runTask other endings", () => {
  it("tells the worker about a failed read and goes on", async () => {
    const { run, last } = await runOf([
      toolUseReply([{ read: pageUrl("missing") }]),
      modelError,
    ]);
    expect(last).toEqual([errorEnd]);
    expect(lastResults(run.requests[1])).toEqual([
      expect.objectContaining({
        is_error: true,
        content: expect.stringContaining(
          "Could not read this page (httpError). Try another source.",
        ),
      }),
    ]);
  });
});

const answerJson = JSON.stringify(goodAnswer);
const reply = (
  text: string,
  stopReason: "end_turn" | "max_tokens" | "refusal" | "pause_turn",
) => ({ ok: true, message: fakeMessage(text, { stopReason }) }) as ModelOutcome;
const answerWith = (fields: Record<string, unknown>) =>
  reply(JSON.stringify({ ...goodAnswer, ...fields }), "end_turn");
const withoutSources = Object.fromEntries(
  Object.entries(goodAnswer).filter(([key]) => key !== "sourceIds"),
);

// Stop reasons that are no answer turn end the run at once, with no rewrite.
const unanswered: { name: string; step: ModelOutcome }[] = [
  { name: "refusal", step: reply(answerJson, "refusal") },
  { name: "pause_turn", step: reply(answerJson, "pause_turn") },
];

const malformedAnswers: { name: string; step: ModelOutcome }[] = [
  { name: "max_tokens", step: reply(answerJson, "max_tokens") },
  { name: "invalid JSON", step: reply("{ not json", "end_turn") },
  { name: "no text block", step: endTurnWith([]) },
  { name: "only a thinking block", step: endTurnWith([thinkingBlock]) },
  {
    name: "two text blocks",
    step: endTurnWith([textBlock(answerJson), textBlock(answerJson)]),
  },
  {
    name: "a missing field",
    step: reply(JSON.stringify(withoutSources), "end_turn"),
  },
  { name: "an extra field", step: answerWith({ notes: "x" }) },
  { name: "an old status field", step: answerWith({ status: "complete" }) },
  {
    name: "a source id that is not a string",
    step: answerWith({ sourceIds: [1] }),
  },
  {
    name: "a line that is not a string",
    step: answerWith({ line: 3 }),
  },
  {
    name: "a nothingFound that is not a string",
    step: answerWith({ nothingFound: 3 }),
  },
];

describe("runTask malformed answers", () => {
  it.each(unanswered)("ends error at once on $name", async (row) => {
    const { last } = await runOf([row.step]);
    expect(last).toEqual([errorEnd]);
  });

  it.each(malformedAnswers)(
    "ends error on $name twice when nothing was found",
    async (row) => {
      const { last } = await runOf([row.step, row.step]);
      expect(last).toEqual([errorEnd]);
    },
  );
});

const malformedCalls: { name: string; step: ModelOutcome }[] = [
  {
    name: "an unknown tool",
    step: toolUseReply([{ name: "fetch", input: { url: pageUrl("one") } }]),
  },
  {
    name: "a search with an extra argument",
    step: toolUseReply([{ name: "search", input: { query: "q", count: 3 } }]),
  },
  {
    name: "a read with a number url",
    step: toolUseReply([{ name: "read", input: { url: 7 } }]),
  },
  {
    name: "a read with no input object",
    step: toolUseReply([{ name: "read", input: "x" }]),
  },
  {
    name: "one bad call beside a good one",
    step: toolUseReply([{ search: "q" }, { name: "read", input: {} }]),
  },
  { name: "a tool_use stop with no tool blocks", step: toolUseReply([]) },
];

describe("runTask malformed tool calls", () => {
  it.each(malformedCalls)(
    "ends error with no tool I/O on $name",
    async (row) => {
      const { run, last } = await runOf([row.step]);
      expect(last).toEqual([errorEnd]);
      expect(run.events).toEqual([errorEnd]);
      expect(run.queries).toEqual([]);
      expect(run.network.targets).toEqual([]);
    },
  );
});

describe("runTask tool batches", () => {
  it("aborts a waiting sibling read when a search ends the task, and waits for it", async () => {
    const run = await startRun(
      [toolUseReply([{ read: pageUrl("slow") }, { search: "hermes" }])],
      [{ ok: false, cause: "keyRejected" }],
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toEqual(keyRejected);
    const tools = run.entries.filter((entry) => entry.event === "toolCall");
    expect(tools.map((entry) => [entry.tool, entry.outcome])).toEqual([
      ["search", "keyRejected"],
      ["read", "aborted"],
    ]);
    expect(
      run.entries.findIndex((entry) => entry.event === "taskEnd"),
    ).toBeGreaterThan(run.entries.findIndex((entry) => entry.tool === "read"));
  });

  it("sends only the searches left when one turn crosses the search limit", async () => {
    const queries = Array.from({ length: 22 }, (_, index) => ({
      search: `query ${index + 1}`,
    }));
    const run = await startRun(
      [toolUseReply(queries)],
      Array.from({ length: 22 }, () => hits(pageUrl("one"))),
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toEqual(failed("limitHit"));
    expect(run.queries).toEqual(
      queries.slice(0, 20).map((call) => call.search),
    );
  });
});
