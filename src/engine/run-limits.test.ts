import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type { Findings } from "../shared/cards";
import type { EngineEvent } from "../shared/engine";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  verdictReply,
  workerAnswer,
} from "./run.harness";
import type { FakeSearchStep } from "./run.harness";
import { htmlPage, sendRoute } from "./plugs/research/fake-network";

afterEach(closeRuns);

const readOne = () => toolUseReply([{ read: pageUrl("one") }]);
const readTwo = () => toolUseReply([{ read: pageUrl("two") }]);
const link = (id: string, name: string) => `[${id}](<${pageUrl(name)}>)`;
const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const two = { id: "s2", url: pageUrl("two"), title: "Page two" };

const listOne: Findings = {
  cardText: `- ${link("s1", "one")} Page one`,
  sources: [one],
  openPoints: [],
};
const listTwo: Findings = {
  cardText: `${listOne.cardText}\n- ${link("s2", "two")} Page two`,
  sources: [one, two],
  openPoints: [],
};

const limitHit = (findings: Findings | null): EngineEvent => ({
  type: "incomplete",
  taskId: "task-1",
  incomplete: { kind: "limitHit", findings },
});

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
    steps: () => Array.from({ length: 16 }, readOne),
    searches: [],
    clock: still,
    calls: 15,
    found: listOne,
  },
  {
    name: "searches",
    steps: () => [
      readOne(),
      ...Array.from({ length: 9 }, (_, index) =>
        toolUseReply([{ search: `query ${index + 1}` }]),
      ),
    ],
    searches: Array.from({ length: 8 }, () => hits(pageUrl("one"))),
    clock: still,
    calls: 10,
    found: listOne,
  },
  {
    name: "active time used by a model call",
    steps: () => [readOne(), readTwo()],
    searches: [],
    clock: (seen) => (seen.calls >= 2 ? 130_000 : 0),
    calls: 2,
    found: listOne,
  },
  {
    name: "active time used by a tool batch",
    steps: () => [readOne(), readTwo(), readOne()],
    searches: [],
    clock: (seen) => (seen.connects >= 2 ? 130_000 : 0),
    calls: 2,
    found: listTwo,
  },
  {
    name: "dollars",
    steps: () => {
      const costly = readTwo();
      if (costly.ok) costly.message.usage.input_tokens = 70_000;
      return [readOne(), costly, readOne()];
    },
    searches: [],
    clock: still,
    calls: 2,
    found: listTwo,
  },
];

async function startClocked(row: Omit<LimitRow, "name" | "calls" | "found">) {
  const seen = { requests: [] as unknown[], targets: [] as unknown[] };
  const now = () =>
    row.clock({ calls: seen.requests.length, connects: seen.targets.length });
  const run = await startRun(row.steps(), row.searches, now);
  seen.requests = run.requests;
  seen.targets = run.network.targets;
  return run;
}

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
    const reads = Array.from({ length: 26 }, () => ({ read: pageUrl("long") }));
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
        cardText: `- ${link("s1", "long")} Long page`,
        sources: [{ id: "s1", url: pageUrl("long"), title: "Long page" }],
        openPoints: [],
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

const cited = {
  cardText: "Hermes runs a loop [s1].",
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }],
};
const checkedCard = {
  cardText: `Hermes runs a loop ${link("s1", "one")}.`,
  sources: [one],
  openPoints: ["How it stores memory"],
};

type LateRow = { name: string; slowCall: number; end: EngineEvent };

const lateRows: LateRow[] = [
  {
    name: "a verdict is kept",
    slowCall: 3,
    end: {
      type: "result",
      taskId: "task-1",
      spokenLine: "Hermes runs a loop of model calls and tools.",
      findings: checkedCard,
    },
  },
  {
    name: "an answer stops the judge",
    slowCall: 2,
    end: limitHit(checkedCard),
  },
];

// A reply already received is used; the limit stops only the next step.
describe("runTask a call past the active time", () => {
  it.each(lateRows)("ends as received: $name", async (row) => {
    const steps: ModelOutcome[] = [
      readOne(),
      workerAnswer(cited),
      verdictReply(),
    ];
    const run = await startClocked({
      steps: () => steps,
      searches: [],
      clock: (seen) => (seen.calls >= row.slowCall ? 130_000 : 0),
    });
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      row.end,
    ]);
    expect(run.requests).toHaveLength(row.slowCall);
  });
});
