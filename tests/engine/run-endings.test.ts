import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome, ModelRequest } from "../../src/providers/anthropic";
import type { SearchOutcome } from "../../src/providers/exa";
import { fakeMessage } from "./harness";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  failed,
  goodAnswer,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
} from "./run.harness";
import type { FakeSearchStep } from "./run.harness";

afterEach(closeRuns);

const errorEnd = failed("error");
const searchDown = failed("searchDown");
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
  it.each(["keyRejected", "quota"])(
    "ends searchDown at once on %s",
    async (cause) => {
      const { run, last } = await runOf(
        [toolUseReply([{ search: "hermes" }])],
        [searchFailed(cause)],
      );
      expect(last).toEqual([searchDown]);
      expect(run.requests).toHaveLength(1);
    },
  );

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

describe("runTask search limits", () => {
  it("ends searchDown on the second failed search of the task", async () => {
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
    expect(events[events.length - 1]).toEqual(searchDown);
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
