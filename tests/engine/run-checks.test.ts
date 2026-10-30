import { afterEach, describe, expect, it } from "vitest";
import type { Findings } from "../../src/shared/cards";
import type { EngineEvent } from "../../src/shared/engine";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  goodAnswer,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const two = { id: "s2", url: pageUrl("two"), title: "Page two" };

const goodFindings: Findings = {
  cardText: "## How it works\n\nHermes runs a loop with tools.",
  sources: [one, two],
};

const readBoth: FakeStep[] = [
  toolUseReply([{ search: "hermes" }]),
  toolUseReply([{ read: pageUrl("one") }]),
  toolUseReply([{ read: pageUrl("two") }]),
];

const search = [hits(pageUrl("one"), pageUrl("two"), pageUrl("three"))];

async function finalEvent(steps: FakeStep[]): Promise<EngineEvent> {
  const run = await startRun(steps, search);
  run.port.send(runTask());
  const events = await run.ended();
  const terminal = events.filter((event) => event.type !== "progress");
  expect(terminal).toHaveLength(1);
  return terminal[0];
}

const result = (findings: Findings): EngineEvent => ({
  type: "result",
  taskId: "task-1",
  spokenLine: goodAnswer.line,
  findings,
});

// Each row ends at once: a rewrite would ask for a model step that is not given, so settle fails.
const validRows = [
  {
    name: "a report and read ids",
    answer: {},
    findings: goodFindings,
  },
  {
    name: "an empty report",
    answer: { report: " " },
    findings: { ...goodFindings, cardText: "" },
  },
  {
    name: "a report of only markers",
    answer: { report: "[s1] [s2]" },
    findings: { ...goodFindings, cardText: "" },
  },
  {
    name: "an unread id beside a read one",
    answer: { sourceIds: ["s1", "s9"] },
    findings: { ...goodFindings, sources: [one] },
  },
  {
    name: "ids out of order, repeated, with markers in the report",
    answer: { report: "A [s3] and B.", sourceIds: ["s2", "s1", "s2"] },
    findings: { ...goodFindings, cardText: "A and B." },
  },
];

describe("runTask valid answers", () => {
  it.each(validRows)(
    "ends as a result with no further model call on $name",
    async (row) => {
      const event = await finalEvent([...readBoth, workerAnswer(row.answer)]);
      expect(event).toEqual(result(row.findings));
    },
  );
});

describe("runTask nothing found", () => {
  it("ends failed with the worker's own sentence, with no rewrite, even after reading", async () => {
    const event = await finalEvent([
      ...readBoth,
      workerAnswer({
        report: "",
        line: " ",
        sourceIds: [],
        nothingFound: " No page mentions a Hermes 9. ",
      }),
    ]);
    expect(event).toEqual({
      type: "failed",
      taskId: "task-1",
      cause: "nothingFound",
      reason: "No page mentions a Hermes 9.",
      findings: null,
    });
  });
});
