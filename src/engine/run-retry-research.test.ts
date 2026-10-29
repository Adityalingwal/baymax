import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type { SearchOutcome } from "../providers/search";
import type { Findings } from "../shared/cards";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  goodAnswer,
  hits,
  pageUrl,
  runTask,
  startRun,
  strayLinks,
  toolUseReply,
  verdictReply,
  workerAnswer,
} from "./run.harness";
import type { FakeSearchStep } from "./run.harness";

afterEach(closeRuns);

const nudgeText =
  "You made no new search and read no new page in this round. Research the gaps in the check result above before you answer: make a search and read at least one new page for each gap, then write the whole answer again as the JSON object.";

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
const firstSearch = hits(pageUrl("one"), pageUrl("two"));
const unmet = (gaps: string[] = ["the price"]) =>
  verdictReply({ goalMet: false, gaps });

async function run(steps: FakeStep[], searches: FakeSearchStep[] = []) {
  const started = await startRun(steps, [firstSearch, ...searches]);
  started.port.send(runTask());
  const events = await started.ended();
  const nudges = started.entries.filter((e) => e.event === "retryNudge");
  const judged = started.entries.filter(
    (e) => e.event === "doneCheck" && e.stage === "judge",
  );
  return {
    ...started,
    events,
    last: events[events.length - 1],
    nudges,
    judged,
  };
}

describe("runTask nudge", () => {
  it("holds back a retry answer made without new research once, then judges the next one", async () => {
    const unresearched = workerAnswer();
    const ran = await run([
      ...reading,
      workerAnswer(),
      unmet(),
      unresearched,
      workerAnswer(),
      verdictReply(),
    ]);
    expect(ran.last).toMatchObject({ type: "result" });
    expect(ran.nudges).toEqual([
      { event: "retryNudge", taskId: "task-1", round: 1 },
    ]);
    expect(ran.judged).toHaveLength(2);
    const [retry, afterNudge] = ran.loopRequests().slice(5);
    const content = unresearched.ok ? unresearched.message.content : [];
    expect(afterNudge.messages).toEqual([
      ...retry.messages,
      { role: "assistant", content },
      { role: "user", content: nudgeText },
    ]);
  });

  it("nudges once in each retry round", async () => {
    const ran = await run([
      ...reading,
      workerAnswer(),
      unmet(),
      workerAnswer(),
      workerAnswer(),
      unmet(),
      workerAnswer(),
      workerAnswer(),
      verdictReply(),
    ]);
    expect(ran.last).toMatchObject({ type: "result" });
    expect(ran.nudges.map((entry) => entry.round)).toEqual([1, 2]);
    expect(ran.judged).toHaveLength(3);
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
      const ran = await run(
        [
          ...reading,
          workerAnswer(),
          unmet(),
          tools,
          workerAnswer(),
          ...(counts ? [] : [workerAnswer()]),
          verdictReply(),
        ],
        found,
      );
      expect(ran.last).toMatchObject({ type: "result" });
      expect(ran.nudges).toHaveLength(counts ? 0 : 1);
    },
  );
});

// Every retry round researches nothing, so each has a nudge before its judged answer.
const unmetEveryRound = (verdict: FakeStep, last: ModelOutcome) => [
  ...reading,
  workerAnswer(),
  verdict,
  workerAnswer(),
  workerAnswer(),
  verdict,
  workerAnswer(),
  last,
  verdict,
];

type EndingRow = { name: string; gaps: string[]; line: string; open: string[] };

const endingRows: EndingRow[] = [
  {
    name: "its gaps, duplicates dropped",
    gaps: ["How it stores memory", " the price ", "the price"],
    line: "**Not found:** How it stores memory; the price",
    open: ["How it stores memory", "the price"],
  },
  {
    name: "the judge's fallback when it named no gap",
    gaps: [" "],
    line: "**Not found:** whether the answer meets the goal",
    open: ["How it stores memory", "whether the answer meets the goal"],
  },
  {
    name: "a gap with Markdown, a tag and two lines escaped",
    gaps: ["[s2](https://evil.example) *now*\n# </card> `x`"],
    line: "**Not found:** \\[s2\\]\\(https://evil.example\\) \\*now\\* \\# \\</card\\> \\`x\\`",
    open: [
      "How it stores memory",
      "[s2](https://evil.example) *now*\n# </card> `x`",
    ],
  },
];

describe("runTask ending after the last round", () => {
  it.each(endingRows)(
    "ends a goal still unmet as a result naming $name",
    async (row) => {
      const last = workerAnswer({ spokenLine: " The last spoken line. " });
      const ran = await run(unmetEveryRound(unmet(row.gaps), last));
      expect(ran.last).toEqual({
        type: "result",
        taskId: "task-1",
        spokenLine: "The last spoken line.",
        findings: {
          ...goodFindings,
          cardText: `${goodFindings.cardText}\n\n${row.line}`,
          openPoints: row.open,
        },
      });
      if (ran.last.type !== "result") throw new Error("no result");
      expect(strayLinks(ran.last.findings)).toEqual([]);
    },
  );

  it("ends unchecked when a claim is still unbacked", async () => {
    const unbacked = verdictReply({
      goalMet: false,
      claimsBacked: false,
      gaps: ["the price"],
    });
    const ran = await run(unmetEveryRound(unbacked, workerAnswer()));
    expect(ran.last).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: {
        kind: "unchecked",
        uncheckedPart: "the price",
        findings: goodFindings,
      },
    });
  });
});

// The model-call limit counts the brief writer's call too, the first of the task.
describe("runTask other retry rounds", () => {
  it("gives a rewrite round after a cut-off answer no nudge", async () => {
    const cut = workerAnswer();
    if (cut.ok) cut.message.stop_reason = "max_tokens";
    const ran = await run([...reading, cut, workerAnswer(), verdictReply()]);
    expect(ran.last).toMatchObject({ type: "result" });
    expect(ran.nudges).toEqual([]);
  });

  it("ends sourcesThin given in a retry round as sourcesThin, unjudged", async () => {
    const ran = await run([
      ...reading,
      workerAnswer(),
      unmet(),
      workerAnswer({ status: "sourcesThin" }),
    ]);
    expect(ran.last).toMatchObject({
      type: "incomplete",
      incomplete: { kind: "sourcesThin" },
    });
    expect(ran.nudges).toEqual([]);
    expect(ran.judged).toHaveLength(1);
  });

  it("ends limitHit with the retry card when the model-call limit comes before its judge", async () => {
    const repeats = Array.from({ length: 17 }, () =>
      toolUseReply([{ read: pageUrl("one") }]),
    );
    const ran = await run([
      ...reading,
      workerAnswer(),
      unmet(),
      toolUseReply([{ read: pageUrl("three") }]),
      ...repeats,
      workerAnswer(),
    ]);
    expect(ran.requests).toHaveLength(25);
    expect(ran.last).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: { kind: "limitHit", findings: goodFindings },
    });
    expect(ran.entries).toContainEqual({
      event: "limitHit",
      taskId: "task-1",
      role: "judge",
      limit: "modelCalls",
    });
  });
});
