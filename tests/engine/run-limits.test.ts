import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome, ModelRequest } from "../../src/providers/anthropic";
import type { Findings } from "../../src/shared/cards";
import type { EngineEvent } from "../../src/shared/engine";
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

const lastAnswer = () => workerAnswer({ sourceIds: ["s1"] });

const overBudget = (step: ModelOutcome): ModelOutcome => {
  if (step.ok) step.message.usage.input_tokens = 430_000;
  return step;
};

const answerWithLine: EngineEvent = {
  type: "result",
  taskId: "task-1",
  spokenLine: goodAnswer.line,
  findings: { cardText: goodAnswer.report, sources: [one] },
};

// The fake clock reads what the run has done so far, so a chosen call or batch takes the whole active time.
type Seen = { calls: number; connects: number };
type LimitRow = {
  name: string;
  steps: () => FakeStep[];
  searches: FakeSearchStep[];
  clock: (seen: Seen) => number;
  calls: number; // the last answer included
  open: number; // tool calls the run ended inside
};

const still = () => 0;

const limitRows: LimitRow[] = [
  {
    name: "model calls",
    steps: () => [...Array.from({ length: 30 }, readOne), lastAnswer()],
    searches: [],
    clock: still,
    calls: 31,
    open: 0,
  },
  {
    name: "searches",
    steps: () => [
      readOne(),
      ...Array.from({ length: 21 }, (_, index) =>
        toolUseReply([{ search: `query ${index + 1}` }]),
      ),
      lastAnswer(),
    ],
    searches: Array.from({ length: 20 }, () => hits(pageUrl("one"))),
    clock: still,
    calls: 23,
    open: 1,
  },
  {
    name: "active time used by a model call",
    steps: () => [readOne(), readTwo(), lastAnswer()],
    searches: [],
    clock: (seen) => (seen.calls >= 2 ? 250_000 : 0),
    calls: 3,
    open: 1,
  },
  {
    name: "active time running out during a model call",
    steps: () => [
      readOne(),
      { ok: false, failure: "unreachable", detail: "deadline" },
      lastAnswer(),
    ],
    searches: [],
    clock: (seen) => (seen.calls >= 2 ? 240_000 : 0),
    calls: 3,
    open: 0,
  },
  {
    name: "active time used by a tool batch",
    steps: () => [readOne(), readTwo(), lastAnswer()],
    searches: [],
    clock: (seen) => (seen.connects >= 2 ? 250_000 : 0),
    calls: 3,
    open: 0,
  },
  {
    name: "dollars",
    steps: () => [readOne(), overBudget(readTwo()), lastAnswer()],
    searches: [],
    clock: still,
    calls: 3,
    open: 0,
  },
  {
    name: "dollars in the rewrite round",
    steps: () => [
      readOne(),
      overBudget(workerAnswer({ line: " ", sourceIds: ["s1"] })),
      lastAnswer(),
    ],
    searches: [],
    clock: still,
    calls: 3,
    open: 0,
  },
];

const notRun = "This call did not run.";

const closing =
  "Stop working now. There are no more searches or reads. Write your final JSON answer from the pages you have read. Write the report and the line as usual: the report holds the full answer, the line only the main finding. Use no set phrase and no apology, and say nothing about stopping or limits in either one.";

// Every tool call in the request's history, and every result that answers one.
function toolIds(request: ModelRequest) {
  const blocks = request.messages.flatMap(({ content }) =>
    typeof content === "string" ? [] : content,
  );
  return {
    calls: blocks.flatMap((block) =>
      block.type === "tool_use" ? [block.id] : [],
    ),
    results: blocks.flatMap((block) =>
      block.type === "tool_result" ? [block.tool_use_id] : [],
    ),
  };
}

async function startClocked(row: Omit<LimitRow, "name" | "calls" | "open">) {
  const seen = { calls: () => 0, targets: [] as unknown[] };
  const now = () =>
    row.clock({ calls: seen.calls(), connects: seen.targets.length });
  const run = await startRun(row.steps(), row.searches, now);
  seen.calls = () => run.requests.length;
  seen.targets = run.network.targets;
  return run;
}

describe("the task limits", () => {
  it("are 30 model calls, 20 searches, 4 minutes and a dollar", () => {
    expect(taskLimits).toEqual({
      modelCalls: 30,
      searches: 20,
      activeMs: 240_000,
      dollars: 1.0,
    });
  });
});

describe("runTask limits", () => {
  it.each(limitRows)(
    "gets one last answer on $name, which is a normal result",
    async (row) => {
      const run = await startClocked(row);
      run.port.send(runTask());
      const events = await run.ended();
      expect(events.filter((event) => event.type !== "progress")).toEqual([
        answerWithLine,
      ]);
      expect(run.requests).toHaveLength(row.calls);
      const last = run.requests[row.calls - 1];
      expect(last.tool_choice).toEqual({ type: "none" });
      expect(last.tools).toEqual(run.requests[0].tools);
      const { calls, results } = toolIds(last);
      expect([...results].sort()).toEqual([...calls].sort());
      const closingTurn = last.messages[last.messages.length - 1];
      const notRunIds = JSON.stringify(closingTurn).split(notRun);
      expect(notRunIds).toHaveLength(row.open + 1);
      expect(closingTurn.content).toContainEqual({
        type: "text",
        text: closing,
      });
    },
  );
});

const pageList = failed("limitHit", listTwo);
const nothingFoundAnswer = {
  report: "",
  line: "",
  sourceIds: [],
  nothingFound: "No answer came on Hermes.",
};

const badLastRows: { name: string; step: () => ModelOutcome }[] = [
  {
    name: "cut off",
    step: () => ({
      ok: true,
      message: fakeMessage("{", { stopReason: "max_tokens" }),
    }),
  },
  {
    name: "malformed",
    step: () => ({ ok: true, message: fakeMessage("{ not json") }),
  },
  { name: "invalid", step: () => workerAnswer({ sourceIds: ["s9"] }) },
  {
    name: "a failed call",
    step: () => ({ ok: false, failure: "keyRejected", detail: "x" }),
  },
  {
    name: "a call with tools it may not use",
    step: () => toolUseReply([{ read: pageUrl("three") }]),
  },
];

describe("runTask a last answer that does not help", () => {
  it.each(badLastRows)(
    "$name: one call, no rewrite, the original cause and the pages",
    async ({ step }) => {
      const run = await startRun([readOne(), overBudget(readTwo()), step()]);
      run.port.send(runTask());
      const events = await run.ended();
      expect(events.filter((event) => event.type !== "progress")).toEqual([
        pageList,
      ]);
      expect(run.requests).toHaveLength(3);
    },
  );

  it("takes nothing found as a normal nothing found with the pages", async () => {
    const run = await startRun([
      readOne(),
      overBudget(readTwo()),
      workerAnswer(nothingFoundAnswer),
    ]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      {
        type: "failed",
        taskId: "task-1",
        cause: "nothingFound",
        reason: nothingFoundAnswer.nothingFound,
        findings: listTwo,
      },
    ]);
  });
});

describe("runTask full prompt", () => {
  it("ends limitHit on dollars before a worker call whose history has grown too long", async () => {
    const reads = Array.from({ length: 150 }, () => ({
      read: pageUrl("long"),
    }));
    const run = await startRun([
      toolUseReply(reads),
      { ok: false, failure: "error", detail: "x" },
    ]);
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
    expect(run.requests).toHaveLength(2);
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
      input: 430_000,
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
    if (costly.ok) costly.message.usage.input_tokens = 430_000;
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
