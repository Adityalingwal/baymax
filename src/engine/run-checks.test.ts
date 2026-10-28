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
const everyRound = (answer: ModelOutcome, verdict: FakeStep[] = []) =>
  readTwo(
    answer,
    ...verdict,
    ...[answer, answer, ...verdict],
    ...[answer, answer, ...verdict],
  );

describe("runTask code check", () => {
  it.each(codeRows)(
    "fails rule $name in every round, without calling the judge",
    async (row) => {
      const event = await finalEvent(everyRound(workerAnswer(row.answer)));
      expect(event).toEqual(unchecked(row.part, row.findings));
    },
  );
});

type JudgeRow = { name: string; verdict: FakeStep; part: string };
type FailedRow = { name: string; verdict: () => FakeStep; ending: EngineEvent };

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

// Only a goal left unmet ends as a result, its gap named on the card; an unbacked part stays unchecked.
const failedVerdicts: FailedRow[] = [
  {
    name: "goalMet false with its gap",
    verdict: () => verdictReply({ goalMet: false, gaps: ["the price"] }),
    ending: {
      type: "result",
      taskId: "task-1",
      spokenLine: goodAnswer.spokenLine,
      findings: {
        ...goodFindings,
        cardText: `${goodFindings.cardText}\n\n**Not found:** the price`,
        openPoints: [...goodAnswer.openPoints, "the price"],
      },
    },
  },
  {
    name: "claimsBacked false with no gap",
    verdict: () => verdictReply({ claimsBacked: false }),
    ending: unchecked(
      "whether the claims are backed by the read pages",
      goodFindings,
    ),
  },
  {
    name: "spokenLineBacked false with an empty gap",
    verdict: () => verdictReply({ spokenLineBacked: false, gaps: [" "] }),
    ending: unchecked(
      "whether the spoken line is backed by the card",
      goodFindings,
    ),
  },
];

// A judge that fails its own call gets no retry round.
const brokenJudges: JudgeRow[] = [
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
  it.each(failedVerdicts)("ends on $name in every round", async (row) => {
    const event = await finalEvent(everyRound(workerAnswer(), [row.verdict()]));
    expect(event).toEqual(row.ending);
  });

  it.each(brokenJudges)("ends unchecked at once on $name", async (row) => {
    const event = await finalEvent(readTwo(workerAnswer(), row.verdict));
    expect(event).toEqual(unchecked(row.part, goodFindings));
  });

  it("ends limitHit with the checked card when the judge call would cross a limit", async () => {
    const costly: ModelOutcome = {
      ok: true,
      message: fakeMessage(JSON.stringify(goodAnswer), {
        usage: { input_tokens: 248_000 },
      }),
    };
    const event = await finalEvent(readTwo(costly));
    expect(event).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: { kind: "limitHit", findings: goodFindings },
    });
  });
});
