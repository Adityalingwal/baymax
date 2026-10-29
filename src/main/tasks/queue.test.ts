import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import { ask, askNew, counts, createHarness, finish } from "./harness";

const queuedLine = "Okay, I'll look at that after the current one.";
const queueFullLine =
  "I already have three waiting. Cancel one or ask again later.";

function fourTasks(): Harness {
  const h = createHarness();
  for (const name of ["hermes", "rust", "zig", "go"]) askNew(h, name);
  return h;
}

function runTaskIds(h: Harness): string[] {
  return h.sent.filter((c) => c.type === "runTask").map((c) => c.taskId);
}

describe("the run slot and the queue", () => {
  it("runs the first new task at once, showing its spoken line without saying anything", () => {
    const h = createHarness();
    askNew(h, "hermes");
    expect(h.sent.at(-1)).toEqual({
      type: "runTask",
      taskId: "t1",
      goalVersion: 1,
      depth: "normal",
      ask: ask("hermes", "tell me hermes"),
      parent: null,
    });
    expect(h.card("t1")).toMatchObject({
      state: "running",
      sayBack: null,
      line: null,
      reply: "Checking hermes.",
    });
    expect(h.said).toEqual([]);
  });
});

describe("the queue", () => {
  it("queues the next three with the queued line on their cards only", () => {
    const h = fourTasks();
    expect(runTaskIds(h)).toEqual(["t1"]);
    for (const taskId of ["t2", "t3", "t4"]) {
      expect(h.card(taskId)).toMatchObject({
        state: "queued",
        line: queuedLine,
      });
      expect(h.said.filter((line) => line.taskId === taskId)).toEqual([]);
    }
  });

  it("refuses a fourth waiting task and lets its card leave at 3000 ms", () => {
    const h = fourTasks();
    askNew(h, "ocaml");
    expect(runTaskIds(h)).toEqual(["t1"]);
    expect(h.card("t5")).toMatchObject({
      state: "cancelled",
      line: queueFullLine,
      canRetry: false,
    });
    expect(h.said.at(-1)).toEqual({
      taskId: "t5",
      text: queueFullLine,
      kind: "failure",
    });
    h.advance(2999);
    expect(h.card("t5")).toBeDefined();
    h.advance(1);
    expect(h.card("t5")).toBeUndefined();
  });
});

describe("leaving the queue", () => {
  it("starts the oldest queued task when the running one finishes, saying only the result", () => {
    const h = fourTasks();
    const saidBefore = h.said.length;
    finish(h, "t1");
    expect(runTaskIds(h)).toEqual(["t1", "t2"]);
    expect(h.card("t2")).toMatchObject({
      state: "running",
      line: null,
      reply: "Checking rust.",
    });
    expect(h.said.slice(saidBefore)).toEqual([
      { taskId: "t1", text: "Done. spoken", kind: "answer" },
    ]);
  });

  it("cancels a queued task without a message and keeps the others' order", () => {
    const h = fourTasks();
    const [, sentBefore, saidBefore] = counts(h);
    h.state.cancelTask("t2");
    expect(h.sent.length).toBe(sentBefore);
    expect(h.said.length).toBe(saidBefore);
    expect(h.card("t2")?.state).toBe("cancelled");
    finish(h, "t1");
    finish(h, "t3");
    expect(runTaskIds(h)).toEqual(["t1", "t3", "t4"]);
  });
});
