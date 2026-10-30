import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../providers/anthropic";
import type { SearchOutcome } from "../providers/exa";
import {
  brief,
  closeRuns,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const oneCited = {
  cardText: "Hermes runs a loop.",
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }],
};

function textOf(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

const toolUseIds = (request: ModelRequest): unknown[] => {
  const turn = request.messages[1].content;
  return Array.isArray(turn)
    ? turn.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))
    : [];
};

describe("runTask parallel tool calls", () => {
  it("sends every result of one turn in one user message, in call order", async () => {
    const lateSearch = new Promise<SearchOutcome>((resolve) =>
      setTimeout(() => resolve(hits(pageUrl("two"))), 50),
    );
    const run = await startRun(
      [
        toolUseReply([
          { search: "hermes" },
          { read: pageUrl("one") },
          { read: pageUrl("missing") },
        ]),
        toolUseReply([{ read: pageUrl("two") }]),
        workerAnswer(oneCited),
      ],
      [lateSearch],
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({ type: "result" });
    const second = run.workerRequests()[1];
    expect(second.messages).toHaveLength(3);
    const results = second.messages[2];
    expect(results.role).toBe("user");
    expect(results.content).toEqual(
      toolUseIds(second).map((id) =>
        expect.objectContaining({ type: "tool_result", tool_use_id: id }),
      ),
    );
    const [search, read, failed] = Array.isArray(results.content)
      ? results.content
      : [];
    expect(textOf(search)).toContain("<search_results>");
    expect(textOf(read)).toContain('<page source_id=\\"s1\\"');
    expect(failed).toMatchObject({ is_error: true });
    expect(search).not.toHaveProperty("is_error");
    expect(run.workerRequests()[2].messages.slice(0, 3)).toEqual(
      second.messages,
    );
  });
});

describe("runTask injected page text", () => {
  it("reaches the worker escaped inside one page block", async () => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("injected") }]),
      workerAnswer(oneCited),
    ]);
    run.port.send(runTask());
    await run.ended();
    const results = run.workerRequests()[1].messages[2].content;
    const block =
      Array.isArray(results) && results[0].type === "tool_result"
        ? results[0].content
        : null;
    if (typeof block !== "string") throw new Error("no tool result text");
    expect(block.match(/<page /g)).toHaveLength(1);
    expect(block.match(/<\/page>/g)).toHaveLength(1);
    expect(block).toContain("&lt;/page&gt;&lt;page source_id=");
  });
});

const loggedEnds = [
  {
    event: "toolCall",
    taskId: "task-1",
    tool: "search",
    outcome: "ok",
    ms: 0,
  },
  {
    event: "toolCall",
    taskId: "task-1",
    tool: "read",
    outcome: "ok",
    ms: 0,
    host: "example.test",
    sourceId: "s1",
    keptHost: "example.test",
  },
  {
    event: "doneCheck",
    taskId: "task-1",
    stage: "code",
    passed: true,
    failed: null,
  },
  { event: "taskEnd", taskId: "task-1", how: "result" },
];
const loggedSources = {
  event: "cardSources",
  taskId: "task-1",
  sourceIds: "s1",
  hosts: "example.test",
};

describe("runTask dev log", () => {
  it("logs tool calls, checks and the end without queries, URLs, pages or words", async () => {
    const run = await startRun(
      [
        toolUseReply([{ search: "hermes secret query" }]),
        toolUseReply([{ read: pageUrl("one") }]),
        workerAnswer(oneCited),
      ],
      [hits(pageUrl("one"))],
    );
    run.port.send(runTask());
    await run.ended();
    const kept = run.entries.filter((entry) =>
      ["toolCall", "doneCheck", "cardSources", "taskEnd"].includes(entry.event),
    );
    expect(kept).toEqual([
      ...loggedEnds.slice(0, 3),
      loggedSources,
      loggedEnds[3],
    ]);
    const logged = JSON.stringify(run.entries);
    for (const secret of [
      "hermes secret query",
      "/one",
      "Plain words",
      brief.userWords,
      brief.goal,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

// Each read in its own turn, so each counter is read after the one before it settled.
describe("runTask counter line", () => {
  it("tells the worker how many pages it has read, failed reads and repeats left out", async () => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      toolUseReply([{ read: pageUrl("missing") }]),
      toolUseReply([{ read: pageUrl("one") }]),
      toolUseReply([{ read: pageUrl("two") }]),
      workerAnswer(oneCited),
    ]);
    run.port.send(runTask());
    await run.ended();
    const counters = run
      .workerRequests()
      .slice(1, 5)
      .map((request) => {
        const text = textOf(request.messages[request.messages.length - 1]);
        const counter =
          /Pages read: (\d+)\. Searches left: 20\. Steps left: \d+\./;
        return counter.exec(text)?.[1];
      });
    expect(counters).toEqual(["1", "1", "1", "2"]);
  });
});
