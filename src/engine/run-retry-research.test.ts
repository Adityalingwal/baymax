import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type { SearchOutcome } from "../providers/search";
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

const nudgeText =
  "You made no new search and read no new page in this round. Research the gaps in the check result above before you answer: make a search and read at least one new page for each gap, then write the whole answer again as the JSON object.";

const reading: FakeStep[] = [
  toolUseReply([{ search: "hermes" }]),
  toolUseReply([{ read: pageUrl("one") }]),
  toolUseReply([{ read: pageUrl("two") }]),
];
const firstSearch = hits(pageUrl("one"), pageUrl("two"));
// A complete answer that cites a page it never read: the code check fails it.
const unread = workerAnswer({
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s9"] }],
});

async function run(steps: FakeStep[], searches: FakeSearchStep[] = []) {
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
    const ran = await run([...reading, unread, unresearched, workerAnswer()]);
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
    const ran = await run([
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
      const ran = await run(
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
    const ran = await run([...reading, cut, workerAnswer()]);
    expect(ran.last).toMatchObject({ type: "result" });
    expect(ran.nudges).toEqual([]);
  });

  it("ends sourcesThin given in a retry round as sourcesThin, unchecked", async () => {
    const ran = await run([
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
    const ran = await run(untilTheLimit());
    expect(ran.requests).toHaveLength(30);
    expect(ran.last).toMatchObject({
      type: "incomplete",
      taskId: "task-1",
      incomplete: {
        kind: "limitHit",
        findings: { cardText: goodAnswer.cardText },
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
