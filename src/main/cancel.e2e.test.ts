import { describe, expect, it } from "vitest";
import type { TaskCard, TaskId } from "../shared/cards";
import type { EngineEvent } from "../shared/engine";
import { ipcChannels } from "../shared/ipc";
import { findings, intake, question } from "./tasks/harness";
import { admitAs, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

type CancelRow = {
  name: string;
  prepare: (w: Wired) => void; // after t1 runs and t2, t3 wait
  taskId: TaskId;
  ending: EngineEvent | null; // the engine's reply that ends the step; null when nothing is in flight
  starts: TaskId | null; // the queued task that runs once the ending arrives
};

const answerSpoken = "Hermes runs a loop.";

function background(w: Wired): void {
  admitAs(w, "t1", "hermes");
  admitAs(w, "t2", "rust");
  admitAs(w, "t3", "zig");
}

const asked = (w: Wired) =>
  w.send(ipcChannels.submitQuestion, { text: "find me a laptop" });

const clarifying = (w: Wired) => {
  asked(w);
  w.port.emit(
    intake("t4", {
      route: "clarify",
      sayBack: "a laptop",
      question: question("q1"),
    }),
  );
};

const cancelled = (taskId: TaskId): EngineEvent => ({
  type: "cancelled",
  taskId,
  findings: null,
});

const rows: CancelRow[] = [
  {
    name: "queued",
    prepare: () => undefined,
    taskId: "t2",
    ending: null,
    starts: null,
  },
  {
    name: "clarifying, question shown and not answered",
    prepare: clarifying,
    taskId: "t4",
    ending: null,
    starts: null,
  },
  {
    name: "thinking after an intake failure",
    prepare: (w) => {
      asked(w);
      w.port.emit({ type: "failure", taskId: "t4", kind: "modelsUnreachable" });
    },
    taskId: "t4",
    ending: null,
    starts: null,
  },
  {
    name: "thinking, intake in flight",
    prepare: asked,
    taskId: "t4",
    ending: cancelled("t4"),
    starts: null,
  },
  {
    name: "clarifying, answer in flight",
    prepare: (w) => {
      clarifying(w);
      w.send(ipcChannels.answerQuestion, {
        taskId: "t4",
        questionId: "q1",
        reply: { kind: "choice", index: 0 },
      });
    },
    taskId: "t4",
    ending: cancelled("t4"),
    starts: null,
  },
  {
    name: "running",
    prepare: () => undefined,
    taskId: "t1",
    ending: cancelled("t1"),
    starts: "t2",
  },
  {
    name: "running, a result arrives instead",
    prepare: () => undefined,
    taskId: "t1",
    ending: {
      type: "result",
      taskId: "t1",
      spokenLine: answerSpoken,
      findings: findings(answerSpoken),
    },
    starts: "t2",
  },
];

const others = (w: Wired, taskId: TaskId): TaskCard[] =>
  w.published.at(-1)?.tasks.filter((card) => card.taskId !== taskId) ?? [];

function prepared(row: CancelRow): Wired {
  const w = wire();
  background(w);
  row.prepare(w);
  return w;
}

// Cancels by the renderer action and delivers the ending reply, if the row has one.
function cancelToEnd(row: CancelRow): Wired {
  const w = prepared(row);
  w.send(ipcChannels.cancelTask, { taskId: row.taskId });
  if (row.ending !== null) w.port.emit(row.ending);
  return w;
}

const immediateRows = rows.filter((row) => row.ending === null);
const cancellingRows = rows.filter((row) => row.ending !== null);

describe("cancel by the renderer action, nothing in flight", () => {
  it.each(immediateRows)("ends $name at once", (row) => {
    const w = prepared(row);
    const sentBefore = w.port.sent.length;
    const othersBefore = others(w, row.taskId);
    w.send(ipcChannels.cancelTask, { taskId: row.taskId });
    expect(w.card(row.taskId)).toMatchObject({
      state: "cancelled",
      line: null,
      question: null,
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
    (row) => {
      const w = prepared(row);
      const sentBefore = w.port.sent.length;
      const othersBefore = others(w, row.taskId);
      w.send(ipcChannels.cancelTask, { taskId: row.taskId });
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

describe("the queue after a cancel", () => {
  it.each(rows)("runs the waiting tasks oldest first after $name", (row) => {
    const w = cancelToEnd(row);
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
  });
});

describe("a cancelled card's lifetime", () => {
  it.each(rows)(
    "shows $name 2999 ms after it ended and not at 3000 ms",
    (row) => {
      const w = cancelToEnd(row);
      w.advance(2999);
      expect(w.card(row.taskId)?.state).toBe("cancelled");
      w.advance(1);
      expect(w.card(row.taskId)).toBeUndefined();
    },
  );

  it.each(rows)(
    "lets a late progress or result for $name change nothing",
    (row) => {
      const w = cancelToEnd(row);
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
    const row = rows[rows.length - 1];
    const w = cancelToEnd(row);
    expect(w.card("t1")?.answer).toBeNull();
    await w.playAll();
    expect(w.syntheses.map((call) => call.input)).not.toContain(answerSpoken);
    expect(w.spoken()).not.toContain(answerSpoken);
  });
});
