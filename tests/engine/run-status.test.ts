import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../../src/providers/anthropic";
import type { Incomplete } from "../../src/shared/engine";
import {
  closeRuns,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  workerAnswer,
} from "./run.harness";
import type { AnswerFields } from "./run.harness";

afterEach(closeRuns);

const one = { id: "s1", url: pageUrl("one"), title: "Page one" };

type StatusRow = { name: string; answer: AnswerFields; ending: Incomplete };

const thinCard = "Only one page mentions it: a loop, and memory.";
const thinFindings = {
  cardText: thinCard,
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

// A retry round would ask for a model step that is not given, so settle fails.
describe("runTask answer status", () => {
  it.each(statusRows)("ends $name without a retry", async (row) => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer(row.answer),
    ]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      { type: "incomplete", taskId: "task-1", incomplete: row.ending },
    ]);
  });
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
  cardText: "Hermes runs a loop.",
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }],
};

describe("runTask invalid answer status", () => {
  it.each(invalidRows)("takes $name as malformed and retries", async (row) => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer({ ...cited, ...row.answer }),
      workerAnswer(cited),
    ]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({ type: "result" });
    expect(run.entries).toContainEqual({
      event: "retryRound",
      taskId: "task-1",
      round: 1,
      stage: "answer",
      rule: "malformed",
    });
  });
});

const thinNudgeText =
  'You chose "sourcesThin" without reading any page in this task. Search for the brief and read pages first; choose "sourcesThin" only when the pages you read do not answer it. Then write the whole answer again as the JSON object.';

const thin = () => workerAnswer({ status: "sourcesThin" });
const readOne = () => toolUseReply([{ read: pageUrl("one") }]);

type ThinRow = {
  name: string;
  steps: () => ModelOutcome[];
  nudges: number;
  codeChecks: number;
  ending: string;
};

const thinRows: ThinRow[] = [
  {
    name: "a zero-read sourcesThin in round 0, then research and a complete answer",
    steps: () => [thin(), readOne(), workerAnswer(cited)],
    nudges: 1,
    codeChecks: 1,
    ending: "result",
  },
  {
    name: "a zero-read sourcesThin twice: only the first is held back",
    steps: () => [thin(), thin()],
    nudges: 1,
    codeChecks: 0,
    ending: "sourcesThin",
  },
  {
    name: "a sourcesThin after only a failed read",
    steps: () => [toolUseReply([{ read: pageUrl("missing") }]), thin(), thin()],
    nudges: 1,
    codeChecks: 0,
    ending: "sourcesThin",
  },
  {
    name: "a sourcesThin after a read page",
    steps: () => [readOne(), thin()],
    nudges: 0,
    codeChecks: 0,
    ending: "sourcesThin",
  },
  {
    name: "a zero-read needsUser with a next question",
    steps: () => [
      workerAnswer({ status: "needsUser", nextQuestion: "Which one?" }),
    ],
    nudges: 0,
    codeChecks: 0,
    ending: "needsUser",
  },
  {
    name: "a zero-read sourcesThin in a retry round, then a zero-research complete answer",
    steps: () => [workerAnswer(cited), thin(), workerAnswer(cited), thin()],
    nudges: 1,
    codeChecks: 2,
    ending: "sourcesThin",
  },
];

describe("runTask zero-read sourcesThin", () => {
  it.each(thinRows)("handles $name", async (row) => {
    const run = await startRun(row.steps());
    run.port.send(runTask());
    const last = (await run.ended()).at(-1);
    const ending =
      last?.type === "incomplete" ? last.incomplete.kind : last?.type;
    expect(ending).toBe(row.ending);
    const count = (event: string) =>
      run.entries.filter((entry) => entry.event === event).length;
    expect(count("thinNudge")).toBe(row.nudges);
    expect(count("retryNudge")).toBe(0);
    const codeChecks = run.entries.filter(
      (entry) => entry.event === "doneCheck" && entry.stage === "code",
    );
    expect(codeChecks).toHaveLength(row.codeChecks);
    const held = run.requests.filter(
      (request) => request.messages.at(-1)?.content === thinNudgeText,
    );
    expect(held).toHaveLength(row.nudges);
    for (const request of held) {
      expect(request.messages.at(-2)?.role).toBe("assistant");
    }
  });
});
