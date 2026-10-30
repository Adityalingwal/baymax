import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../../src/providers/anthropic";
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
import type { AnswerFields } from "./run.harness";

afterEach(closeRuns);

const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const two = { id: "s2", url: pageUrl("two"), title: "Page two" };

const goodFindings: Findings = {
  cardText: "## How it works\n\nHermes runs a loop with tools.",
  sources: [one, two],
  openPoints: goodAnswer.openPoints,
};

// Reads page one, then page two, after a search that also lists page three; then the given answer.
const readTwo = (answer: ModelOutcome, ...rest: FakeStep[]): FakeStep[] => [
  toolUseReply([{ search: "hermes" }]),
  toolUseReply([{ read: pageUrl("one") }]),
  toolUseReply([{ read: pageUrl("two") }]),
  answer,
  ...rest,
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

const unchecked = (uncheckedPart: string, findings: Findings): EngineEvent => ({
  type: "incomplete",
  taskId: "task-1",
  incomplete: { kind: "unchecked", uncheckedPart, findings },
});

type CodeRow = {
  name: string;
  answer: AnswerFields;
  part: string;
  findings: Findings;
};

const claimOne = [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }];

const codeRows: CodeRow[] = [
  {
    name: "(1) an empty spoken line",
    answer: { spokenLine: "  " },
    part: "an empty spoken line or card text",
    findings: goodFindings,
  },
  {
    name: "(1) an empty card text",
    answer: { cardText: "\n" },
    part: "an empty spoken line or card text",
    findings: { ...goodFindings, cardText: "" },
  },
  {
    name: "(1) a card of only markers",
    answer: { cardText: "[s1] [s2]" },
    part: "an empty spoken line or card text",
    findings: { ...goodFindings, cardText: "" },
  },
  {
    name: "(2) no claims",
    answer: { claims: [] },
    part: "claims without a source",
    findings: { ...goodFindings, sources: [] },
  },
  {
    name: "(2) a claim with no source id",
    answer: {
      claims: [...claimOne, { claim: "It uses tools", sourceIds: [] }],
    },
    part: "claims without a source",
    findings: { ...goodFindings, sources: [one] },
  },
  {
    name: "(3) a claim naming a page not read",
    answer: {
      cardText: "A loop and memory.",
      claims: [...claimOne, { claim: "It has memory", sourceIds: ["s7"] }],
    },
    part: "citations to pages that were not read",
    findings: {
      ...goodFindings,
      cardText: "A loop and memory.",
      sources: [one],
    },
  },
  {
    name: "(3) a claim citing a snippet-only page by id",
    answer: {
      cardText: "A loop.",
      claims: [{ claim: "A loop", sourceIds: ["s1", "s3"] }],
    },
    part: "citations to pages that were not read",
    findings: {
      ...goodFindings,
      cardText: "A loop.",
      sources: [one],
    },
  },
];

// Each retry round researches nothing, so its first answer gets the nudge and its second fails the same way; the third check ends the run.
const everyRound = (answer: ModelOutcome) =>
  readTwo(answer, answer, answer, answer, answer);

describe("runTask card sources", () => {
  it("takes sources only from the claims' ids, in read order, ignoring markers", async () => {
    const answer = workerAnswer({
      cardText: "A [s3] and B.",
      claims: [
        { claim: "A", sourceIds: ["s2"] },
        { claim: "B", sourceIds: ["s1", "s2"] },
      ],
    });
    const event = await finalEvent([
      toolUseReply([{ search: "hermes" }]),
      toolUseReply([{ read: pageUrl("one") }]),
      toolUseReply([{ read: pageUrl("two") }]),
      toolUseReply([{ read: pageUrl("three") }]),
      answer,
    ]);
    if (event.type !== "result") throw new Error(`ended ${event.type}`);
    expect(event.findings.sources.map((source) => source.id)).toEqual([
      "s1",
      "s2",
    ]);
  });
});

describe("runTask code check", () => {
  it.each(codeRows)("fails rule $name in every round", async (row) => {
    const event = await finalEvent(everyRound(workerAnswer(row.answer)));
    expect(event).toEqual(unchecked(row.part, row.findings));
  });

  it("ends as a result at once when the code check passes, with no further model call", async () => {
    const run = await startRun(readTwo(workerAnswer(), workerAnswer()), search);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      {
        type: "result",
        taskId: "task-1",
        spokenLine: goodAnswer.spokenLine,
        findings: goodFindings,
      },
    ]);
    expect(run.requests).toHaveLength(4);
  });
});
