import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome, ModelRequest } from "../providers/anthropic";
import type { SearchOutcome } from "../providers/exa";
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
import type { FakeSearchStep } from "./run.harness";

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

const nudgeText =
  "You made no new search and read no new page in this round. Research the gaps in the check result above before you answer: make a search and read at least one new page for each gap, then write the whole answer again as the JSON object.";

const firstSearch = hits(pageUrl("one"), pageUrl("two"));
// A complete answer that cites a page it never read: the code check fails it.
const unread = workerAnswer({
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s9"] }],
});

async function runNudged(steps: FakeStep[], searches: FakeSearchStep[] = []) {
  const started = await startRun(steps, [firstSearch, ...searches]);
  started.port.send(runTask());
  const events = await started.ended();
  const nudges = started.entries.filter((e) => e.event === "retryNudge");
  const checked = started.entries.filter(
    (e) => e.event === "doneCheck" && e.stage === "code",
  );
  return {
    ...started,
    events,
    last: events[events.length - 1],
    nudges,
    checked,
  };
}

describe("runTask nudge", () => {
  it("holds back a retry answer made without new research once, then checks the next one", async () => {
    const unresearched = workerAnswer();
    const ran = await runNudged([
      ...reading,
      unread,
      unresearched,
      workerAnswer(),
    ]);
    expect(ran.last).toMatchObject({ type: "result" });
    expect(ran.nudges).toEqual([
      { event: "retryNudge", taskId: "task-1", round: 1 },
    ]);
    expect(ran.checked).toHaveLength(2);
    const [retry, afterNudge] = ran.loopRequests().slice(4);
    const content = unresearched.ok ? unresearched.message.content : [];
    expect(afterNudge.messages).toEqual([
      ...retry.messages,
      { role: "assistant", content },
      { role: "user", content: nudgeText },
    ]);
  });

  it("nudges once in each retry round", async () => {
    const ran = await runNudged([
      ...reading,
      unread,
      unread,
      unread,
      workerAnswer(),
      workerAnswer(),
    ]);
    expect(ran.last).toMatchObject({ type: "result" });
    expect(ran.nudges.map((entry) => entry.round)).toEqual([1, 2]);
    expect(ran.checked).toHaveLength(3);
  });
});

const searchTimeout: SearchOutcome = { ok: false, cause: "timeout" };
const noHits: SearchOutcome = { ok: true, hits: [] };

const readOf = (...names: string[]) =>
  toolUseReply(names.map((name) => ({ read: pageUrl(name) })));
const searched = () => toolUseReply([{ search: "hermes price" }]);

// name, the retry round's tool turn, its search outcomes, whether it counts as new research
const researchRows: [string, ModelOutcome, FakeSearchStep[], boolean][] = [
  ["a failed read", readOf("missing"), [], false],
  ["a refused read", toolUseReply([{ read: "http://localhost/" }]), [], false],
  ["a failed search", searched(), [searchTimeout], false],
  ["a search with no results", searched(), [noHits], false],
  ["a repeat read of a kept page", readOf("one"), [], false],
  ["a failed and a repeat read together", readOf("missing", "two"), [], false],
  ["a search with results", searched(), [hits(pageUrl("three"))], true],
  ["a read of a new page", readOf("three"), [], true],
];

describe("runTask new research in a retry round", () => {
  it.each(researchRows)(
    "counts %s: %s",
    async (_name, tools, found, counts) => {
      const ran = await runNudged(
        [
          ...reading,
          unread,
          tools,
          workerAnswer(),
          ...(counts ? [] : [workerAnswer()]),
        ],
        found,
      );
      expect(ran.last).toMatchObject({ type: "result" });
      expect(ran.nudges).toHaveLength(counts ? 0 : 1);
    },
  );
});

// Tool turns to the end of the model-call limit, which counts the brief writer's call too, the first of the task.
const untilTheLimit = (): FakeStep[] => [
  ...reading,
  unread,
  toolUseReply([{ read: pageUrl("three") }]),
  ...Array.from({ length: 24 }, () => toolUseReply([{ read: pageUrl("one") }])),
  workerAnswer(),
];

describe("runTask other retry rounds", () => {
  it("gives a rewrite round after a cut-off answer no nudge", async () => {
    const cut = workerAnswer();
    if (cut.ok) cut.message.stop_reason = "max_tokens";
    const ran = await runNudged([...reading, cut, workerAnswer()]);
    expect(ran.last).toMatchObject({ type: "result" });
    expect(ran.nudges).toEqual([]);
  });

  it("ends sourcesThin given in a retry round as sourcesThin, unchecked", async () => {
    const ran = await runNudged([
      ...reading,
      unread,
      workerAnswer({ status: "sourcesThin" }),
    ]);
    expect(ran.last).toMatchObject({
      type: "incomplete",
      incomplete: { kind: "sourcesThin" },
    });
    expect(ran.nudges).toEqual([]);
    expect(ran.checked).toHaveLength(1);
  });

  it("ends limitHit with the retry card when the model-call limit comes during the retry round", async () => {
    const ran = await runNudged(untilTheLimit());
    expect(ran.requests).toHaveLength(30);
    expect(ran.last).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: {
        kind: "limitHit",
        findings: {
          cardText: goodAnswer.cardText,
          sources: [],
          openPoints: goodAnswer.openPoints,
        },
        spokenLine: goodAnswer.spokenLine,
      },
    });
    expect(ran.entries).toContainEqual({
      event: "limitHit",
      taskId: "task-1",
      role: "worker",
      limit: "modelCalls",
    });
  });
});
