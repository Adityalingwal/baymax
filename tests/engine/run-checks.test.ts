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

async function finalEvent(
  steps: FakeStep[],
  searches = search,
): Promise<EngineEvent> {
  const run = await startRun(steps, [...searches]);
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

const gaveUp = () =>
  workerAnswer({
    report: "",
    line: "",
    sourceIds: [],
    nothingFound: "No answer came on Hermes.",
  });

const searchOnly = () => toolUseReply([{ search: "hermes" }]);

const notRead =
  "You said you found nothing, but you haven't read a page. Read the most promising result from your searches, then answer.";

describe("runTask nothing found without reading a page", () => {
  it("sends the worker back to read one, once, and takes its result", async () => {
    const run = await startRun(
      [
        searchOnly(),
        gaveUp(),
        toolUseReply([{ read: pageUrl("one") }]),
        workerAnswer({ sourceIds: ["s1"] }),
      ],
      [...search],
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(run.requests[2].messages.at(-1)?.content).toBe(
      `<check_result>\n${notRead}\n</check_result>\n\nRead one of those pages now, then write the whole answer as the JSON object. In sourceIds, name only pages you read.`,
    );
    expect(events.at(-1)).toEqual(result({ ...goodFindings, sources: [one] }));
  });

  it("accepts the second nothing found with its reason, never as an error", async () => {
    const event = await finalEvent([searchOnly(), gaveUp(), gaveUp()]);
    expect(event).toEqual({
      type: "failed",
      taskId: "task-1",
      cause: "nothingFound",
      reason: "No answer came on Hermes.",
      findings: null,
    });
  });
});

describe("runTask nothing found with no page to send it to", () => {
  it.each([
    {
      name: "a search with no hits",
      steps: () => [searchOnly(), gaveUp()],
      searches: [hits()],
    },
    {
      name: "hits and a read that failed",
      steps: () => [
        searchOnly(),
        toolUseReply([{ read: pageUrl("missing") }]),
        gaveUp(),
      ],
      searches: search,
    },
    {
      name: "hits and a refused read",
      steps: () => [
        searchOnly(),
        toolUseReply([{ read: "http://localhost/" }]),
        gaveUp(),
      ],
      searches: search,
    },
  ])("takes it at once after $name", async ({ steps, searches }) => {
    const event = await finalEvent(steps(), searches);
    expect(event).toMatchObject({ type: "failed", cause: "nothingFound" });
  });
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
      findings: {
        cardText: "- Page one\n- Page two",
        sources: [one, two],
      },
    });
  });

  it("carries no findings when no page was read", async () => {
    const event = await finalEvent([
      workerAnswer({
        report: "",
        line: "",
        sourceIds: [],
        nothingFound: "Nothing helped.",
      }),
    ]);
    expect(event).toEqual({
      type: "failed",
      taskId: "task-1",
      cause: "nothingFound",
      reason: "Nothing helped.",
      findings: null,
    });
  });
});
