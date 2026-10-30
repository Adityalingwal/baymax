import { describe, expect, it } from "vitest";
import type { TaskId } from "../shared/cards";
import { admitAs, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

// The fixed lines as written, so a changed cause or fix in the app fails here.
const fixedLines = {
  queued: "Okay, I'll look at that after the current one.",
  queueFull: "I already have three waiting. Cancel one or ask again later.",
};

const names = ["hermes", "rust", "zig", "go", "ocaml"];

async function fiveAsked(): Promise<Wired> {
  const w = wire();
  for (const name of names) await admitAs(w, name);
  return w;
}

const runTaskIds = (w: Wired): TaskId[] =>
  w.port.sent.filter((c) => c.type === "runTask").map((c) => c.taskId);

const finish = (w: Wired, taskId: TaskId) =>
  w.port.emit({
    type: "result",
    taskId,
    spokenLine: `${taskId} found it.`,
    findings: { cardText: "Found.", sources: [], openPoints: [] },
  });

describe("five typed questions through the wiring", () => {
  it("runs the first, queues the next three and refuses the fifth", async () => {
    const w = await fiveAsked();
    expect(runTaskIds(w)).toEqual(["t1"]);
    expect(w.card("t1")).toMatchObject({
      state: "running",
      reply: "Checking hermes.",
      line: null,
    });
    for (const taskId of ["t2", "t3", "t4"]) {
      expect(w.card(taskId)).toMatchObject({
        state: "queued",
        line: fixedLines.queued,
      });
    }
    expect(w.card("t5")).toMatchObject({
      state: "cancelled",
      line: fixedLines.queueFull,
      canRetry: false,
    });
    expect(w.failures).toEqual([]);
  });

  it("takes the refused card away at 3000 ms and leaves the other four", async () => {
    const w = await fiveAsked();
    const others = () => ["t1", "t2", "t3", "t4"].map((id) => w.card(id));
    const before = others();
    w.advance(2999);
    expect(w.card("t5")).toBeDefined();
    w.advance(1);
    expect(w.card("t5")).toBeUndefined();
    expect(others()).toEqual(before);
    expect(w.published.at(-1)?.tasks.map((card) => card.taskId)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("speech for five typed questions", () => {
  it("says each front line and the queue-full line, even after the refused card left; the queued lines show on the cards only", async () => {
    const w = await fiveAsked();
    // The refused card leaves at 3000 ms; its line is still said.
    w.advance(3000);
    await flush();
    await w.playAll();
    expect(w.stops).toEqual([]);
    expect(w.spoken()).toEqual([
      ...names.map((name) => `Checking ${name}.`),
      fixedLines.queueFull,
    ]);
    expect(w.card("t2")?.line).toBe(fixedLines.queued);
  });
});

describe("the queue moving on through the wiring", () => {
  it("says only the running task's result when the next one starts", async () => {
    const w = await fiveAsked();
    await flush();
    await w.playAll();
    const spokenBefore = w.spoken().length;
    w.port.emit({
      type: "result",
      taskId: "t1",
      spokenLine: "Done. spoken",
      findings: { cardText: "Done.", sources: [], openPoints: [] },
    });
    expect(runTaskIds(w)).toEqual(["t1", "t2"]);
    await flush();
    await w.playAll();
    expect(w.spoken().slice(spokenBefore)).toEqual(["Done. spoken"]);
  });

  it("starts the oldest queued task when the running one ends, and keeps the rest in order", async () => {
    const w = await fiveAsked();
    finish(w, "t1");
    expect(runTaskIds(w)).toEqual(["t1", "t2"]);
    expect(w.card("t2")).toMatchObject({
      state: "running",
      reply: "Checking rust.",
      line: null,
    });
    expect(w.card("t3")?.state).toBe("queued");
    expect(w.card("t4")?.state).toBe("queued");
    finish(w, "t2");
    expect(runTaskIds(w)).toEqual(["t1", "t2", "t3"]);
    expect(w.card("t4")?.state).toBe("queued");
  });
});
