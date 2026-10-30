import { describe, expect, it } from "vitest";
import type { TaskCard, TaskId } from "../../src/shared/cards";
import type { EngineEvent } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import { findings, workRoute } from "./tasks/harness";
import { admitAs, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

// After t1 runs and t2, t3 wait.
type CancelRow = {
  name: string;
  taskId: TaskId;
  ending: EngineEvent | null; // the engine's reply that ends the step; null when nothing is in flight
  starts: TaskId | null; // the queued task that runs once the ending arrives
};

const answerSpoken = "Hermes runs a loop.";

async function background(w: Wired): Promise<void> {
  await admitAs(w, "hermes");
  await admitAs(w, "rust");
  await admitAs(w, "zig");
}

const asked = (w: Wired) =>
  w.send(ipcChannels.submitQuestion, { text: "find me a laptop" });

const cancelled = (taskId: TaskId): EngineEvent => ({
  type: "cancelled",
  taskId,
  findings: null,
});

const rows: CancelRow[] = [
  {
    name: "queued",
    taskId: "t2",
    ending: null,
    starts: null,
  },
  {
    name: "running",
    taskId: "t1",
    ending: cancelled("t1"),
    starts: "t2",
  },
  {
    name: "running, a result arrives instead",
    taskId: "t1",
    ending: {
      type: "result",
      taskId: "t1",
      spokenLine: answerSpoken,
      findings: findings(answerSpoken),
    },
    starts: "t2",
  },
  {
    name: "running, a failure arrives instead",
    taskId: "t1",
    ending: {
      type: "failed",
      taskId: "t1",
      cause: "limitHit",
      reason: null,
      findings: findings("Part."),
    },
    starts: "t2",
  },
];

const done = (taskId: TaskId): EngineEvent => ({
  type: "result",
  taskId,
  spokenLine: "Done.",
  findings: findings("Done."),
});

const others = (w: Wired, taskId: TaskId): TaskCard[] =>
  w.published.at(-1)?.tasks.filter((card) => card.taskId !== taskId) ?? [];

async function prepared(): Promise<Wired> {
  const w = wire();
  await background(w);
  return w;
}

// Cancels by the renderer action and delivers the ending reply, if the row has one.
async function cancelToEnd(row: CancelRow): Promise<Wired> {
  const w = await prepared();
  w.send(ipcChannels.cancelTask, { taskId: row.taskId });
  if (row.ending !== null) w.port.emit(row.ending);
  return w;
}

const immediateRows = rows.filter((row) => row.ending === null);
const cancellingRows = rows.filter((row) => row.ending !== null);

describe("cancel by the renderer action, nothing in flight", () => {
  it.each(immediateRows)("ends $name at once", async (row) => {
    const w = await prepared();
    const sentBefore = w.port.sent.length;
    const othersBefore = others(w, row.taskId);
    w.send(ipcChannels.cancelTask, { taskId: row.taskId });
    expect(w.card(row.taskId)).toMatchObject({
      state: "cancelled",
      line: null,
      step: null,
      answer: null,
      canRetry: false,
    });
    expect(w.port.sent).toHaveLength(sentBefore);
    expect(others(w, row.taskId)).toEqual(othersBefore);
    expect(w.failures).toEqual([]);
  });
});

describe("cancel by the renderer action, a step in flight", () => {
  it.each(cancellingRows)(
    "shows $name cancelling until the ending reply",
    async (row) => {
      const w = await prepared();
      const sentBefore = w.port.sent.length;
      const othersBefore = others(w, row.taskId);
      const before = w.card(row.taskId);
      w.send(ipcChannels.cancelTask, { taskId: row.taskId });
      expect(w.card(row.taskId)).toEqual({
        ...before,
        state: "cancelling",
        canRetry: false,
      });
      w.advance(60_000);
      expect(w.card(row.taskId)?.state).toBe("cancelling");
      expect(w.port.sent.slice(sentBefore)).toEqual([
        { type: "cancel", taskId: row.taskId },
      ]);
      expect(others(w, row.taskId)).toEqual(othersBefore);
      if (row.ending !== null) w.port.emit(row.ending);
      expect(w.card(row.taskId)).toMatchObject({
        state: "cancelled",
        answer: null,
      });
      expectNextStarted(w, row, sentBefore + 1, othersBefore);
      expect(w.failures).toEqual([]);
    },
  );
});

// After the ending, only the row's queued task moves: it runs; every other card is as before.
function expectNextStarted(
  w: Wired,
  row: CancelRow,
  sentAt: number,
  othersBefore: TaskCard[],
): void {
  const started = w.port.sent.slice(sentAt);
  if (row.starts === null) {
    expect(started).toEqual([]);
    expect(others(w, row.taskId)).toEqual(othersBefore);
    return;
  }
  expect(started.map((c) => [c.type, c.taskId])).toEqual([
    ["runTask", row.starts],
  ]);
  expect(w.card(row.starts)?.state).toBe("running");
  const unmoved = (cards: TaskCard[]) =>
    cards.filter((card) => card.taskId !== row.starts);
  expect(unmoved(others(w, row.taskId))).toEqual(unmoved(othersBefore));
}

describe("cancelling a running task's speech", () => {
  it("stops its playing line at the cancel, before the engine replies", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.settleNext();
    const lineId = w.speeches[0].lineId;
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    expect(w.port.events).toEqual([]);
    expect(w.stops).toEqual([{ lineId }]);
    w.port.emit(cancelled("t1"));
    expect(w.stops).toEqual([{ lineId }]);
  });
});

describe("the queue after a cancel", () => {
  it.each(rows)(
    "runs the waiting tasks oldest first after $name",
    async (row) => {
      const w = await cancelToEnd(row);
      for (const taskId of ["t1", "t2", "t3"]) {
        if (w.card(taskId)?.state !== "running") continue;
        w.port.emit({
          type: "result",
          taskId,
          spokenLine: "Done.",
          findings: findings("Done."),
        });
      }
      const runs = w.port.sent.filter((c) => c.type === "runTask");
      const expected = ["t1", "t2", "t3"].filter(
        (id) => id !== row.taskId || id === "t1",
      );
      expect(runs.map((c) => c.taskId)).toEqual(expected);
    },
  );
});

describe("a cancelled card's lifetime", () => {
  it.each(rows)(
    "shows $name 2999 ms after it ended and not at 3000 ms",
    async (row) => {
      const w = await cancelToEnd(row);
      w.advance(2999);
      expect(w.card(row.taskId)?.state).toBe("cancelled");
      w.advance(1);
      expect(w.card(row.taskId)).toBeUndefined();
    },
  );

  it.each(rows)(
    "lets a late progress or result for $name change nothing",
    async (row) => {
      const w = await cancelToEnd(row);
      const published = w.published.length;
      const { taskId } = row;
      w.port.emit({
        type: "progress",
        taskId,
        step: { tool: "search", query: "late" },
        sourcesRead: 1,
      });
      w.port.emit({
        type: "result",
        taskId,
        spokenLine: "Late.",
        findings: findings("Late."),
      });
      expect(w.published).toHaveLength(published);
    },
  );
});

describe("a result that ends a cancelling task", () => {
  it("shows no answer and speaks none", async () => {
    const row = rows.find((other) => other.ending?.type === "result");
    if (row === undefined) throw new Error("no row ends with a result");
    const w = await cancelToEnd(row);
    expect(w.card("t1")?.answer).toBeNull();
    await w.playAll();
    expect(w.syntheses.map((call) => call.input)).not.toContain(answerSpoken);
    expect(w.spoken()).not.toContain(answerSpoken);
  });
});

describe("a late front reply for a cancelled card", () => {
  it("changes nothing: no card, no answer bound, no work admitted", async () => {
    const w = wire();
    await background(w);
    asked(w);
    w.send(ipcChannels.cancelTask, { taskId: "t4" });
    const published = w.published.length;
    const sent = w.port.sent.length;
    w.wiring.state.talkerReplied("t4", "t4#1", {
      kind: "said",
      text: "Late.",
      decision: workRoute("laptops"),
    });
    w.wiring.state.talkerReplied("t4", "t4#1", {
      kind: "failed",
      failure: "error",
    });
    expect(w.published).toHaveLength(published);
    expect(w.port.sent).toHaveLength(sent);
    expect(w.card("t4")).toBeUndefined();
  });
});

const endedRows: { name: string; taskId: TaskId; end: (w: Wired) => void }[] = [
  {
    name: "a cancelling task",
    taskId: "t1",
    end: (w) => w.send(ipcChannels.cancelTask, { taskId: "t1" }),
  },
  { name: "a done task", taskId: "t1", end: (w) => w.port.emit(done("t1")) },
  {
    name: "a cancelled task",
    taskId: "t2",
    end: (w) => w.send(ipcChannels.cancelTask, { taskId: "t2" }),
  },
  { name: "an unknown task", taskId: "t9", end: () => undefined },
];

describe("a cancel that changes nothing", () => {
  it.each(endedRows)("is dropped for $name", async ({ taskId, end }) => {
    const w = wire();
    await background(w);
    end(w);
    const counts = () => [
      w.published.length,
      w.port.sent.length,
      w.syntheses.length,
    ];
    const before = counts();
    w.send(ipcChannels.cancelTask, { taskId });
    expect(counts()).toEqual(before);
  });
});

describe("a cancel the engine sends unasked", () => {
  it("ends the running task cancelled and frees the slot for the next", async () => {
    const w = wire();
    await background(w);
    w.port.emit(cancelled("t1"));
    expect(w.card("t1")?.state).toBe("cancelled");
    expect(w.card("t2")?.state).toBe("running");
  });
});
