import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type { EngineEvent } from "../shared/engine";
import {
  closeRuns,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const cancelled: EngineEvent = {
  type: "cancelled",
  taskId: "task-1",
  findings: null,
};
const cancel = { type: "cancel" as const, taskId: "task-1" };
const searchStep: EngineEvent = {
  type: "progress",
  taskId: "task-1",
  step: { tool: "search", query: "hermes" },
  sourcesRead: 0,
};

function thrown(): Promise<ModelOutcome> {
  const call = Promise.reject(new Error("boom"));
  call.catch(() => undefined);
  return call;
}

describe("runTask cancel", () => {
  it("stops a waiting worker call with one cancelled and nothing after", async () => {
    const run = await startRun(["waitForAbort"]);
    run.port.send(runTask());
    await run.settle();
    run.port.send(cancel);
    expect(await run.ended()).toEqual([cancelled]);
    expect(await run.settle(2)).toEqual([cancelled]);
    expect(run.loopRequests()).toHaveLength(1);
  });

  it("stops a waiting search with one cancelled and no further call", async () => {
    const run = await startRun(
      [toolUseReply([{ search: "hermes" }]), workerAnswer()],
      ["waitForAbort", hits(pageUrl("one"))],
    );
    run.port.send(runTask());
    await run.settle(1);
    run.port.send(cancel);
    expect(await run.ended()).toEqual([searchStep, cancelled]);
    expect(await run.settle(3)).toEqual([searchStep, cancelled]);
    expect(run.loopRequests()).toHaveLength(1);
    expect(run.queries).toHaveLength(1);
  });

  it("answers a repeated cancel of a held run with one cancelled", async () => {
    const run = await startRun(["waitForAbort"]);
    run.port.send(runTask());
    run.port.send(cancel);
    run.port.send(cancel);
    expect(await run.ended()).toEqual([cancelled]);
    expect(await run.settle(2)).toEqual([cancelled]);
  });
});

describe("runTask cancel from a listener", () => {
  it.each([
    { name: "search", call: { search: "hermes" } },
    { name: "read", call: { read: pageUrl("one") } },
  ])("sends no $name once a progress listener cancels", async (row) => {
    const run = await startRun(
      [toolUseReply([row.call])],
      [hits(pageUrl("one"))],
    );
    run.port.onMessage((event) => {
      if (event.type === "progress") run.port.send(cancel);
    });
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      cancelled,
    ]);
    expect(run.queries).toEqual([]);
    expect(run.network.targets).toEqual([]);
  });
});

describe("runTask cancel at the end", () => {
  it("sends no cancelled after the result when a result listener cancels", async () => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer({
        cardText: "A loop.",
        claims: [{ claim: "A loop", sourceIds: ["s1"] }],
      }),
    ]);
    run.port.onMessage((event) => {
      if (event.type === "result") run.port.send(cancel);
    });
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      expect.objectContaining({ type: "result" }),
    ]);
    expect(run.entries).toContainEqual({
      event: "cancelAfterEnd",
      taskId: "task-1",
    });
  });
});

describe("runTask holds", () => {
  it("ignores and logs a second runTask for a held task", async () => {
    const run = await startRun(["waitForAbort"]);
    run.port.send(runTask());
    run.port.send(runTask());
    await run.settle();
    expect(run.loopRequests()).toHaveLength(1);
    expect(run.entries).toContainEqual({
      event: "duplicateTask",
      taskId: "task-1",
    });
    run.port.send(cancel);
    expect(await run.ended()).toEqual([cancelled]);
  });

  it("releases the hold of a thrown run, so the same task id runs again", async () => {
    const failed: ModelOutcome = { ok: false, failure: "error", detail: "x" };
    const run = await startRun([thrown(), failed]);
    run.port.send(runTask());
    const errorEnd: EngineEvent = {
      type: "incomplete",
      taskId: "task-1",
      incomplete: { kind: "error", cause: "error", findings: null },
    };
    expect(await run.ended()).toEqual([errorEnd]);
    run.port.send(runTask());
    expect(await run.settle(2)).toEqual([errorEnd, errorEnd]);
    expect(run.loopRequests()).toHaveLength(2);
    expect(run.entries).toContainEqual(
      expect.objectContaining({ event: "taskEnd", how: "thrown" }),
    );
  });
});

describe("runTask tool batches", () => {
  it("aborts a waiting sibling read when a search ends the task, and waits for it", async () => {
    const run = await startRun(
      [toolUseReply([{ read: pageUrl("slow") }, { search: "hermes" }])],
      [{ ok: false, cause: "keyRejected" }],
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: { kind: "error", cause: "searchDown", findings: null },
    });
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
    expect(events[events.length - 1]).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: { kind: "limitHit", findings: null },
    });
    expect(run.queries).toEqual(
      queries.slice(0, 20).map((call) => call.search),
    );
  });
});
