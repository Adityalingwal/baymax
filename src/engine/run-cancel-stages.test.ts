import { afterEach, describe, expect, it } from "vitest";
import type { Findings } from "../shared/cards";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  until,
  verdictReply,
  workerAnswer,
} from "./run.harness";
import type { FakeSearchStep } from "./run.harness";

afterEach(closeRuns);

const cancel = { type: "cancel" as const, taskId: "task-1" };

const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const readOne = () => toolUseReply([{ read: pageUrl("one") }]);
const answered = (cardText: string, sourceIds = ["s1"]) =>
  workerAnswer({
    cardText,
    claims: [{ claim: "Hermes runs a loop", sourceIds }],
  });
const card = (cardText: string): Findings => ({
  cardText,
  sources: [one],
  openPoints: ["How it stores memory"],
});

type Sent = { calls: number; queries: number; connects: number };
type StageRow = {
  name: string;
  steps: () => FakeStep[];
  searches?: FakeSearchStep[];
  at: (sent: Sent) => boolean; // the stage is in flight
  found: Findings | null;
};

const stageRows: StageRow[] = [
  {
    name: "a worker call",
    steps: () => ["waitForAbort"],
    at: (sent) => sent.calls === 1,
    found: null,
  },
  {
    name: "a search",
    steps: () => [readOne(), toolUseReply([{ search: "hermes" }])],
    searches: ["waitForAbort"],
    at: (sent) => sent.queries === 1,
    found: { cardText: "- Page one", sources: [one], openPoints: [] },
  },
  {
    name: "a read",
    steps: () => [readOne(), toolUseReply([{ read: pageUrl("slow") }])],
    at: (sent) => sent.connects === 2,
    found: { cardText: "- Page one", sources: [one], openPoints: [] },
  },
  {
    name: "the judge",
    steps: () => [readOne(), answered("A loop."), "waitForAbort"],
    at: (sent) => sent.calls === 3,
    found: card("A loop."),
  },
  {
    name: "the retry round's worker call",
    steps: () => [
      readOne(),
      answered("A loop, memory.", ["s1", "s7"]),
      "waitForAbort",
    ],
    at: (sent) => sent.calls === 3,
    found: card("A loop, memory."),
  },
  {
    name: "the retry round's judge",
    steps: () => [
      readOne(),
      answered("A loop."),
      verdictReply({ goalMet: false }),
      toolUseReply([{ read: pageUrl("two") }]),
      answered("A loop again."),
      "waitForAbort",
    ],
    at: (sent) => sent.calls === 6,
    found: card("A loop again."),
  },
  {
    name: "the worker call after a nudge",
    steps: () => [
      readOne(),
      answered("A loop."),
      verdictReply({ goalMet: false }),
      answered("A loop again."),
      "waitForAbort",
    ],
    at: (sent) => sent.calls === 5,
    found: card("A loop."),
  },
];

describe("runTask cancel at each stage", () => {
  it.each(stageRows)(
    "stops $name with one cancelled carrying what was found",
    async (row) => {
      const run = await startRun(row.steps(), row.searches ?? []);
      const sent = (): Sent => ({
        calls: run.requests.length,
        queries: run.queries.length,
        connects: run.network.targets.length,
      });
      run.port.send(runTask());
      await until(() => row.at(sent()));
      const atCancel = sent();
      run.port.send(cancel);
      const events = await run.ended();
      const cancelled = {
        type: "cancelled",
        taskId: "task-1",
        findings: row.found,
      };
      expect(events.filter((event) => event.type !== "progress")).toEqual([
        cancelled,
      ]);
      expect(events[events.length - 1]).toEqual(cancelled);
      const count = events.length;
      expect(await run.settle()).toHaveLength(count);
      expect(sent()).toEqual(atCancel);
    },
  );
});

const cancelledNull = { type: "cancelled", taskId: "task-1", findings: null };

describe("runTask repeated cancel", () => {
  // A cancel in every microtask until cancelled arrives also lands between the work settling and the delivery.
  it("sends one cancelled when cancels keep coming until it arrives", async () => {
    const run = await startRun(["waitForAbort"]);
    run.port.send(runTask());
    await until(() => run.requests.length === 1);
    run.port.send(cancel);
    for (let turn = 0; turn < 100; turn += 1) {
      await Promise.resolve();
      if (run.events.length > 0) break;
      run.port.send(cancel);
    }
    expect(await run.ended()).toEqual([cancelledNull]);
    expect(await run.settle(2)).toEqual([cancelledNull]);
  });

  it("sends one cancelled when a cancelled listener cancels again", async () => {
    const run = await startRun(["waitForAbort"]);
    let again = true;
    run.port.onMessage((event) => {
      if (event.type !== "cancelled" || !again) return;
      again = false;
      run.port.send(cancel);
    });
    run.port.send(runTask());
    await until(() => run.requests.length === 1);
    run.port.send(cancel);
    expect(await run.ended()).toEqual([cancelledNull]);
    expect(await run.settle(2)).toEqual([cancelledNull]);
  });
});
