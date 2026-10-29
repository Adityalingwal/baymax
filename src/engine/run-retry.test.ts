import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome, ModelRequest } from "../providers/anthropic";
import type { Findings } from "../shared/cards";
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
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const goodFindings: Findings = {
  cardText: "## How it works\n\nHermes runs a loop with tools.",
  sources: [
    { id: "s1", url: pageUrl("one"), title: "Page one" },
    { id: "s2", url: pageUrl("two"), title: "Page two" },
  ],
  openPoints: goodAnswer.openPoints,
};

const reading: FakeStep[] = [
  toolUseReply([{ search: "hermes" }]),
  toolUseReply([{ read: pageUrl("one") }]),
  toolUseReply([{ read: pageUrl("two") }]),
];

const search = [hits(pageUrl("one"), pageUrl("two"))];

const rewriteLine =
  "Your answer did not pass the check above. Write the whole answer again as the JSON object, fixing that part. Cite only pages you read.";

const researchLine =
  'Your answer did not pass the check above. Research each gap first: for each gap, make a search and read at least one new page. If the web does not have a gap, put it in openPoints and say in one line of the card that it was not found. Remove any claim you cannot back with a page you read. In this retry round, use status "complete", not "sourcesThin". Then write the whole answer again as the JSON object, citing only pages you read.';

const answerText = (text: string, cut = false): ModelOutcome => ({
  ok: true,
  message: fakeMessage(text, { stopReason: cut ? "max_tokens" : "end_turn" }),
});

type RetryRow = {
  name: string;
  failed: ModelOutcome; // the first answer turn
  stage: string;
  rule: string;
  result: string; // what the check_result block says
  line: string;
};

const readThree = toolUseReply([{ read: pageUrl("three") }]);

const retryRows: RetryRow[] = [
  {
    name: "a failed code rule",
    failed: workerAnswer({
      claims: [{ claim: "Hermes runs a loop", sourceIds: ["s9"] }],
    }),
    stage: "code",
    rule: "unreadCitation",
    result: "citations to pages that were not read",
    line: researchLine,
  },
  {
    name: "malformed answer JSON",
    failed: answerText("{ not json"),
    stage: "answer",
    rule: "malformed",
    result: "The answer was not valid JSON for the schema.",
    line: rewriteLine,
  },
  {
    name: "an answer cut at max_tokens",
    failed: answerText(JSON.stringify(goodAnswer), true),
    stage: "answer",
    rule: "cutOff",
    result:
      "The answer was cut off at the length limit. Write a shorter card text.",
    line: rewriteLine,
  },
];

const promptStart = (request: ModelRequest) =>
  JSON.stringify([request.system, request.tools, request.cache_control]);

const contentOf = (step: ModelOutcome) => (step.ok ? step.message.content : []);

describe("runTask retry round", () => {
  it.each(retryRows)(
    "answers again after $name and ends with the second answer checked",
    async (row) => {
      const run = await startRun(
        [...reading, row.failed, readThree, workerAnswer()],
        search,
      );
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
      const asked = run.loopRequests()[3];
      const retry = run.loopRequests()[4];
      expect(retry.messages).toEqual([
        ...asked.messages,
        { role: "assistant", content: contentOf(row.failed) },
        {
          role: "user",
          content: `<check_result>\n${row.result}\n</check_result>\n\n${row.line}`,
        },
      ]);
      expect(promptStart(retry)).toBe(promptStart(run.loopRequests()[0]));
      expect(run.entries).toContainEqual({
        event: "retryRound",
        taskId: "task-1",
        round: 1,
        stage: row.stage,
        rule: row.rule,
      });
      const nudges = run.entries.filter((e) => e.event === "retryNudge");
      expect(nudges).toEqual([]);
    },
  );
});

describe("runTask after the last retry round", () => {
  it("never asks for a fourth checked answer", async () => {
    const unread = workerAnswer({
      claims: [{ claim: "Hermes runs a loop", sourceIds: ["s9"] }],
    });
    const readNew = (name: string) => toolUseReply([{ read: pageUrl(name) }]);
    const run = await startRun(
      [
        ...reading,
        unread,
        readNew("three"),
        unread,
        readNew("paren(1)"),
        unread,
        workerAnswer(),
      ],
      search,
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({
      type: "incomplete",
      incomplete: {
        kind: "unchecked",
        uncheckedPart: "citations to pages that were not read",
      },
    });
    expect(run.loopRequests()).toHaveLength(8);
    const checked = run.entries.filter(
      (entry) => entry.event === "doneCheck" && entry.stage === "code",
    );
    expect(checked).toHaveLength(3);
    const retries = run.entries.filter((entry) => entry.event === "retryRound");
    expect(retries.map((entry) => entry.round)).toEqual([1, 2]);
  });
});
