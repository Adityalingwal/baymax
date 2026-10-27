import { afterEach, describe, expect, it } from "vitest";
import type { Incomplete } from "../shared/engine";
import {
  closeRuns,
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

type StatusRow = { name: string; answer: AnswerFields; ending: Incomplete };

const thinCard = "Only one page mentions it: a loop [s1], and memory [s4].";
const thinFindings = {
  cardText: `Only one page mentions it: a loop [s1](<${pageUrl("one")}>), and memory .`,
  sources: [one],
  openPoints: ["How it stores memory"],
};
const askCard = "Hermes names two products; which one is meant is unclear.";

const statusRows: StatusRow[] = [
  {
    name: "sourcesThin with card text",
    answer: { status: "sourcesThin", cardText: thinCard },
    ending: { kind: "sourcesThin", findings: thinFindings },
  },
  {
    name: "sourcesThin with an empty card",
    answer: { status: "sourcesThin", cardText: " ", claims: [] },
    ending: { kind: "sourcesThin", findings: null },
  },
  {
    name: "needsUser with an uncited card",
    answer: {
      status: "needsUser",
      nextQuestion: " The agent or the CLI? ",
      cardText: askCard,
      claims: [],
      openPoints: [],
    },
    ending: {
      kind: "needsUser",
      nextQuestion: "The agent or the CLI?",
      findings: { cardText: askCard, sources: [], openPoints: [] },
    },
  },
  {
    name: "needsUser with an empty card",
    answer: {
      status: "needsUser",
      nextQuestion: "Which Hermes?",
      cardText: "",
    },
    ending: {
      kind: "needsUser",
      nextQuestion: "Which Hermes?",
      findings: null,
    },
  },
];

// No verdict step is given: a judge call or a retry round would fail the test in settle.
describe("runTask answer status", () => {
  it.each(statusRows)(
    "ends $name without the judge or a retry",
    async (row) => {
      const run = await startRun([
        toolUseReply([{ read: pageUrl("one") }]),
        workerAnswer(row.answer),
      ]);
      run.port.send(runTask());
      const events = await run.ended();
      expect(events.filter((event) => event.type !== "progress")).toEqual([
        { type: "incomplete", taskId: "task-1", incomplete: row.ending },
      ]);
    },
  );
});

const invalidRows: { name: string; answer: AnswerFields }[] = [
  { name: "an unknown status", answer: { status: "partial" } },
  {
    name: "complete with a next question",
    answer: { status: "complete", nextQuestion: "Which one?" },
  },
  {
    name: "sourcesThin with a next question",
    answer: { status: "sourcesThin", nextQuestion: "Which one?" },
  },
  {
    name: "needsUser with no next question",
    answer: { status: "needsUser", nextQuestion: null },
  },
  {
    name: "needsUser with a blank next question",
    answer: { status: "needsUser", nextQuestion: "  " },
  },
];

const cited = {
  cardText: "Hermes runs a loop [s1].",
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }],
};

describe("runTask invalid answer status", () => {
  it.each(invalidRows)("takes $name as malformed and retries", async (row) => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer({ ...cited, ...row.answer }),
      workerAnswer(cited),
      verdictReply(),
    ]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({ type: "result" });
    expect(run.entries).toContainEqual({
      event: "retryRound",
      taskId: "task-1",
      stage: "answer",
      rule: "malformed",
    });
  });
});
