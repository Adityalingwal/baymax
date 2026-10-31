import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../../src/providers/anthropic";
import type { Findings } from "../../src/shared/cards";
import type { EngineEvent } from "../../src/shared/engine";
import { startTestEngine } from "./harness";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  until,
  workerAnswer,
} from "./run.harness";
import type { FakeSearchStep } from "./run.harness";

afterEach(closeRuns);

const cancel = { type: "cancel" as const, taskId: "task-1" };

const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const readOne = () => toolUseReply([{ read: pageUrl("one") }]);
const rejected = () => workerAnswer({ line: " " });
// A read whose reported usage leaves no room for the next call, so the run goes to its last answer.
const overBudget = () => {
  const step = readOne();
  if (step.ok) step.message.usage.input_tokens = 430_000;
  return step;
};
const listOne: Findings = {
  cardText: "- Page one",
  sources: [one],
};

type Sent = {
  calls: number;
  queries: number;
  connects: number;
};
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
    found: listOne,
  },
  {
    name: "a read",
    steps: () => [readOne(), toolUseReply([{ read: pageUrl("slow") }])],
    at: (sent) => sent.connects === 2,
    found: listOne,
  },
  {
    name: "the last answer's call",
    steps: () => [overBudget(), "waitForAbort"],
    at: (sent) => sent.calls === 2,
    found: listOne,
  },
  {
    name: "the rewrite's worker call, leaving out the rejected answer",
    steps: () => [readOne(), rejected(), "waitForAbort"],
    at: (sent) => sent.calls === 3,
    found: listOne,
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

type RepeatRow = {
  name: string;
  cancelAgain: (run: Awaited<ReturnType<typeof startRun>>) => Promise<void>;
};

const repeatRows: RepeatRow[] = [
  {
    name: "a second cancel sent at once",
    cancelAgain: async (run) => {
      run.port.send(cancel);
      run.port.send(cancel);
    },
  },
  {
    // A cancel in every microtask until cancelled arrives also lands between the work settling and the delivery.
    name: "cancels that keep coming until it arrives",
    cancelAgain: async (run) => {
      await until(() => run.requests.length === 1);
      run.port.send(cancel);
      for (let turn = 0; turn < 100; turn += 1) {
        await Promise.resolve();
        if (run.events.length > 0) break;
        run.port.send(cancel);
      }
    },
  },
  {
    name: "a cancelled listener that cancels again",
    cancelAgain: async (run) => {
      let again = true;
      run.port.onMessage((event) => {
        if (event.type !== "cancelled" || !again) return;
        again = false;
        run.port.send(cancel);
      });
      await until(() => run.requests.length === 1);
      run.port.send(cancel);
    },
  },
];

describe("runTask repeated cancel", () => {
  it.each(repeatRows)("sends one cancelled after $name", async (row) => {
    const run = await startRun(["waitForAbort"]);
    run.port.send(runTask());
    await row.cancelAgain(run);
    expect(await run.ended()).toEqual([cancelledNull]);
    expect(await run.settle(2)).toEqual([cancelledNull]);
  });
});

describe("runTask cancel from a listener", () => {
  it.each([
    { name: "search", call: { search: "hermes" } },
    { name: "read", call: { read: pageUrl("one") } },
  ])("sends no $name once a progress listener cancels", async (row) => {
    const run = await startRun(
      [toolUseReply([row.call])],
      [hits(pageUrl("one"))],
    );
    run.port.onMessage((event) => {
      if (event.type === "progress") run.port.send(cancel);
    });
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      cancelledNull,
    ]);
    expect(run.queries).toEqual([]);
    expect(run.network.targets).toEqual([]);
  });
});

describe("runTask cancel at the edges", () => {
  it("sends no cancelled after the result when a result listener cancels", async () => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer({ report: "A loop.", sourceIds: ["s1"] }),
    ]);
    run.port.onMessage((event) => {
      if (event.type === "result") run.port.send(cancel);
    });
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      expect.objectContaining({ type: "result" }),
    ]);
    expect(run.entries).toContainEqual({
      event: "cancelAfterEnd",
      taskId: "task-1",
    });
  });

  it("answers a cancel for a task not held, after send returns", async () => {
    const engine = startTestEngine([]);
    engine.port.send({ type: "cancel", taskId: "task-5" });
    expect(engine.events).toEqual([]);
    const notHeld: EngineEvent = {
      type: "cancelled",
      taskId: "task-5",
      findings: null,
    };
    expect(await engine.settle(1)).toEqual([notHeld]);
  });

  it("drops a model answer that arrives after its cancel", async () => {
    let answer: (outcome: ModelOutcome) => void = () => undefined;
    const late = new Promise<ModelOutcome>((resolve) => (answer = resolve));
    const engine = startTestEngine([late]);
    engine.port.send(runTask());
    engine.port.send(cancel);
    answer(workerAnswer());
    expect(await engine.settle(2)).toEqual([cancelledNull]);
  });
});
