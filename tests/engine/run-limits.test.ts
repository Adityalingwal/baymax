import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../../src/providers/anthropic";
import type { Findings } from "../../src/shared/cards";
import type { EngineEvent } from "../../src/shared/engine";
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
  workerAnswer,
} from "./run.harness";
import type { FakeSearchStep } from "./run.harness";
import { taskLimits } from "../../src/engine/core/limits";
import { htmlPage, sendRoute } from "./plugs/research/fake-network";

afterEach(closeRuns);

const readOne = () => toolUseReply([{ read: pageUrl("one") }]);
const readTwo = () => toolUseReply([{ read: pageUrl("two") }]);
const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const two = { id: "s2", url: pageUrl("two"), title: "Page two" };

const listOne: Findings = {
  cardText: "- Page one",
  sources: [one],
};
const listTwo: Findings = {
  cardText: `${listOne.cardText}\n- Page two`,
  sources: [one, two],
};

const limitHit = (findings: Findings | null): EngineEvent =>
  failed("limitHit", findings);

// The fake clock reads what the run has done so far, so a chosen call or batch takes the whole active time.
type Seen = { calls: number; connects: number };
type LimitRow = {
  name: string;
  steps: () => FakeStep[];
  searches: FakeSearchStep[];
  clock: (seen: Seen) => number;
  calls: number;
  found: Findings;
};

const still = () => 0;

const limitRows: LimitRow[] = [
  {
    name: "model calls",
    steps: () => Array.from({ length: 31 }, readOne),
    searches: [],
    clock: still,
    calls: 30,
    found: listOne,
  },
  {
    name: "searches",
    steps: () => [
      readOne(),
      ...Array.from({ length: 21 }, (_, index) =>
        toolUseReply([{ search: `query ${index + 1}` }]),
      ),
    ],
    searches: Array.from({ length: 20 }, () => hits(pageUrl("one"))),
    clock: still,
    calls: 22,
    found: listOne,
  },
  {
    name: "active time used by a model call",
    steps: () => [readOne(), readTwo()],
    searches: [],
    clock: (seen) => (seen.calls >= 2 ? 250_000 : 0),
    calls: 2,
    found: listOne,
  },
  {
    name: "active time used by a tool batch",
    steps: () => [readOne(), readTwo(), readOne()],
    searches: [],
    clock: (seen) => (seen.connects >= 2 ? 250_000 : 0),
    calls: 2,
    found: listTwo,
  },
  {
    name: "dollars",
    steps: () => {
      const costly = readTwo();
      if (costly.ok) costly.message.usage.input_tokens = 248_000;
      return [readOne(), costly, readOne()];
    },
    searches: [],
    clock: still,
    calls: 2,
    found: listTwo,
  },
];

async function startClocked(row: Omit<LimitRow, "name" | "calls" | "found">) {
  const seen = { calls: () => 0, targets: [] as unknown[] };
  const now = () =>
    row.clock({ calls: seen.calls(), connects: seen.targets.length });
  const run = await startRun(row.steps(), row.searches, now);
  seen.calls = () => run.requests.length;
  seen.targets = run.network.targets;
  return run;
}

describe("the task limits", () => {
  it("are 30 model calls, 20 searches, 4 minutes and 50 cents", () => {
    expect(taskLimits).toEqual({
      modelCalls: 30,
      searches: 20,
      activeMs: 240_000,
      dollars: 0.5,
    });
  });
});

describe("runTask limits", () => {
  it.each(limitRows)(
    "ends limitHit on $name with what was found",
    async (row) => {
      const run = await startClocked(row);
      run.port.send(runTask());
      const events = await run.ended();
      expect(events.filter((event) => event.type !== "progress")).toEqual([
        limitHit(row.found),
      ]);
      expect(run.requests).toHaveLength(row.calls);
    },
  );
});

describe("runTask full prompt", () => {
  it("ends limitHit on dollars before a worker call whose history has grown too long", async () => {
    const reads = Array.from({ length: 90 }, () => ({ read: pageUrl("long") }));
    const run = await startRun([toolUseReply(reads), readOne()]);
    const text = "Long words about the Hermes agent for the prompt. ".repeat(
      200,
    );
    const body = htmlPage("Long page", `<p>${text}</p>`);
    const headers = { "Content-Type": "text/html" };
    run.network.route("/long", sendRoute({ headers, body }));
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toEqual(
      limitHit({
        cardText: "- Long page",
        sources: [{ id: "s1", url: pageUrl("long"), title: "Long page" }],
      }),
    );
    expect(run.requests).toHaveLength(1);
    expect(run.entries).toContainEqual({
      event: "limitHit",
      taskId: "task-1",
      role: "worker",
      limit: "dollars",
    });
  });
});

// A reply already received is used; the limit stops only the next step.
describe("runTask a valid answer that uses up the budget", () => {
  it.each([
    {
      name: "active time",
      clock: (seen: Seen) => (seen.calls >= 2 ? 250_000 : 0),
    },
    {
      name: "dollars",
      clock: still,
      input: 248_000,
    },
  ])("keeps its line and findings: $name", async ({ clock, input }) => {
    const answer = workerAnswer({ sourceIds: ["s1"] });
    if (answer.ok && input !== undefined) {
      answer.message.usage.input_tokens = input;
    }
    const run = await startClocked({
      steps: () => [readOne(), answer],
      searches: [],
      clock,
    });
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      {
        type: "result",
        taskId: "task-1",
        spokenLine: goodAnswer.line,
        findings: {
          cardText: goodAnswer.report,
          sources: [one],
        },
      },
    ]);
    expect(run.requests).toHaveLength(2);
  });
});

const lastResults = (request: ModelRequest): unknown =>
  request.messages[request.messages.length - 1].content;

// Limits met with nothing found: the task ends limitHit without findings.
const nothingFound: EngineEvent = limitHit(null);

describe("runTask limits with nothing found", () => {
  it("ends limitHit at the 21st search without sending it", async () => {
    const steps = Array.from({ length: 21 }, (_, index) =>
      toolUseReply([{ search: `query ${index + 1}` }]),
    );
    const searches = Array.from({ length: 21 }, () => hits(pageUrl("one")));
    const run = await startRun(steps, searches);
    run.port.send(runTask());
    const last = (await run.ended()).filter(
      (event) => event.type !== "progress",
    );
    expect(last).toEqual([nothingFound]);
    expect(run.queries).toHaveLength(20);
    expect(lastResults(run.requests[20])).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Searches left: 0."),
      }),
    ]);
  });
});

describe("runTask active time with nothing found", () => {
  it("ends limitHit before a tool batch once the active time is used up", async () => {
    const times = [0, 250_000];
    const now = () => times.shift() ?? 250_000;
    const run = await startRun(
      [toolUseReply([{ search: "hermes" }])],
      [hits(pageUrl("one"))],
      now,
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events).toEqual([nothingFound]);
    expect(run.queries).toEqual([]);
  });

  it("ends limitHit when the next worker call would cross a limit", async () => {
    const costly = toolUseReply([{ search: "hermes" }]);
    if (costly.ok) costly.message.usage.input_tokens = 248_000;
    const run = await startRun([costly], [hits(pageUrl("one"))]);
    run.port.send(runTask());
    const last = (await run.ended()).filter(
      (event) => event.type !== "progress",
    );
    expect(last).toEqual([nothingFound]);
    expect(run.requests).toHaveLength(1);
  });
  it("counts a tool batch's time as active time", async () => {
    const sent: { queries: string[] } = { queries: [] };
    const now = () => (sent.queries.length > 0 ? 250_000 : 0);
    const run = await startRun(
      [toolUseReply([{ search: "hermes" }])],
      [hits(pageUrl("one"))],
      now,
    );
    sent.queries = run.queries;
    run.port.send(runTask());
    expect(await run.ended()).toEqual([
      expect.objectContaining({ type: "progress" }),
      nothingFound,
    ]);
    expect(run.queries).toEqual(["hermes"]);
    expect(run.requests).toHaveLength(1);
  });
});
