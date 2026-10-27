import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type { Findings } from "../shared/cards";
import type { EngineEvent } from "../shared/engine";
import { fakeMessage } from "./harness";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  goodAnswer,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  verdictReply,
  workerAnswer,
} from "./run.harness";
import type { AnswerFields } from "./run.harness";

afterEach(closeRuns);

const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const two = { id: "s2", url: pageUrl("two"), title: "Page two" };
const linked = (id: string, name: string) => `[${id}](${pageUrl(name)})`;

const goodFindings: Findings = {
  cardText: `## How it works\n\nHermes runs a loop ${linked("s1", "one")} with tools ${linked("s2", "two")}.`,
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

const unchecked = (uncheckedPart: string, findings: Findings) => ({
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
    name: "(2) no claims",
    answer: { claims: [] },
    part: "claims without a source",
    findings: goodFindings,
  },
  {
    name: "(2) a claim with no source id",
    answer: {
      claims: [...claimOne, { claim: "It uses tools", sourceIds: [] }],
    },
    part: "claims without a source",
    findings: goodFindings,
  },
  {
    name: "(3) a card with no marker",
    answer: { cardText: "Hermes runs a loop.", claims: claimOne },
    part: "a card with no citations",
    findings: {
      ...goodFindings,
      cardText: "Hermes runs a loop.",
      sources: [one],
    },
  },
  {
    name: "(4) a marker for a page not read",
    answer: { cardText: "A loop [s1] and memory [s7].", claims: claimOne },
    part: "citations to pages that were not read",
    findings: {
      ...goodFindings,
      cardText: `A loop ${linked("s1", "one")} and memory [s7].`,
      sources: [one],
    },
  },
  {
    name: "(4) a claim citing a snippet-only page by id",
    answer: {
      cardText: "A loop [s1].",
      claims: [{ claim: "A loop", sourceIds: ["s1", "s3"] }],
    },
    part: "citations to pages that were not read",
    findings: {
      ...goodFindings,
      cardText: `A loop ${linked("s1", "one")}.`,
      sources: [one],
    },
  },
  {
    name: "(5) a link to a snippet-only page",
    answer: {
      cardText: `A loop [s1], see [the docs](${pageUrl("three")}).`,
      claims: claimOne,
    },
    part: "links to pages that were not read",
    findings: {
      ...goodFindings,
      cardText: `A loop ${linked("s1", "one")}, see the docs.`,
      sources: [one],
    },
  },
  {
    name: "(5) a reference definition",
    answer: {
      cardText: `A loop [s1] in [the docs][d].\n\n[d]: ${pageUrl("one")}`,
      claims: claimOne,
    },
    part: "links to pages that were not read",
    findings: {
      ...goodFindings,
      cardText: `A loop ${linked("s1", "one")} in [the docs][d].`,
      sources: [one],
    },
  },
  {
    name: "(5) an autolink",
    answer: {
      cardText: `A loop [s1] at <${pageUrl("one")}>.`,
      claims: claimOne,
    },
    part: "links to pages that were not read",
    findings: {
      ...goodFindings,
      cardText: `A loop ${linked("s1", "one")} at ${pageUrl("one")}.`,
      sources: [one],
    },
  },
];

describe("runTask code check", () => {
  it.each(codeRows)(
    "fails rule $name, without calling the judge",
    async (row) => {
      const event = await finalEvent(readTwo(workerAnswer(row.answer)));
      expect(event).toEqual(unchecked(row.part, row.findings));
    },
  );

  it("passes a link to a read page and keeps it", async () => {
    const cardText = `A loop [s1], see [the docs](${pageUrl("two")}).`;
    const event = await finalEvent(
      readTwo(workerAnswer({ cardText, claims: claimOne }), verdictReply()),
    );
    expect(event).toMatchObject({
      type: "result",
      findings: {
        cardText: `A loop ${linked("s1", "one")}, see [the docs](${pageUrl("two")}).`,
        sources: [one, two],
      },
    });
  });
});

type JudgeRow = { name: string; verdict: FakeStep; part: string };

// Handled here so it only rejects where the engine awaits it.
function thrown(): Promise<ModelOutcome> {
  const call = Promise.reject(new Error("boom"));
  call.catch(() => undefined);
  return call;
}

const withText = (
  text: string,
  stopReason: "end_turn" | "max_tokens" = "end_turn",
): ModelOutcome => ({
  ok: true,
  message: fakeMessage(text, { stopReason }),
});

const judgeRows: JudgeRow[] = [
  {
    name: "goalMet false with its part",
    verdict: verdictReply({ goalMet: false, uncheckedPart: "the price" }),
    part: "the price",
  },
  {
    name: "claimsBacked false with no part",
    verdict: verdictReply({ claimsBacked: false }),
    part: "whether the claims are backed by the read pages",
  },
  {
    name: "spokenLineBacked false with an empty part",
    verdict: verdictReply({ spokenLineBacked: false, uncheckedPart: " " }),
    part: "whether the spoken line is backed by the card",
  },
  {
    name: "a verdict with an extra field",
    verdict: verdictReply({ reason: "x" }),
    part: "the whole answer",
  },
  {
    name: "a verdict with a string flag",
    verdict: verdictReply({ goalMet: "yes" }),
    part: "the whole answer",
  },
  {
    name: "a verdict that is not JSON",
    verdict: withText("all good"),
    part: "the whole answer",
  },
  {
    name: "a verdict cut at max_tokens",
    verdict: withText("{", "max_tokens"),
    part: "the whole answer",
  },
  {
    name: "a failed judge call",
    verdict: { ok: false, failure: "unreachable", detail: "x" },
    part: "the whole answer",
  },
  { name: "a thrown judge call", verdict: thrown(), part: "the whole answer" },
];

describe("runTask judge", () => {
  it.each(judgeRows)("ends unchecked on $name", async (row) => {
    const event = await finalEvent(readTwo(workerAnswer(), row.verdict));
    expect(event).toEqual(unchecked(row.part, goodFindings));
  });

  it("ends limitHit with no findings when the judge call would cross a limit", async () => {
    const costly: ModelOutcome = {
      ok: true,
      message: fakeMessage(JSON.stringify(goodAnswer), {
        usage: { input_tokens: 70_000 },
      }),
    };
    const event = await finalEvent(readTwo(costly));
    expect(event).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: { kind: "limitHit", findings: null },
    });
  });
});
