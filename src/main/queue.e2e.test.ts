import { describe, expect, it } from "vitest";
import type { TaskId } from "../shared/cards";
import { fixedLines } from "./tasks/lines";
import { admitAs, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const names = ["hermes", "rust", "zig", "go", "ocaml"];

function fiveAsked(): Wired {
  const w = wire();
  names.forEach((name, index) => admitAs(w, `t${index + 1}`, name));
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
  it("runs the first, queues the next three and refuses the fifth", () => {
    const w = fiveAsked();
    expect(runTaskIds(w)).toEqual(["t1"]);
    expect(w.card("t1")).toMatchObject({
      state: "running",
      line: "Looking into hermes.",
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

  it("takes the refused card away at 3000 ms and leaves the other four", () => {
    const w = fiveAsked();
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

describe("speech for five typed questions", () => {
  it("speaks one line at a time: the start line, three queued lines, the queue-full line", async () => {
    const w = fiveAsked();
    const order = [
      "Looking into hermes.",
      fixedLines.queued,
      fixedLines.queued,
      fixedLines.queued,
      fixedLines.queueFull,
    ];
    for (let index = 0; index < order.length; index += 1) {
      expect(w.syntheses.map((call) => call.input)).toEqual(
        order.slice(0, index + 1),
      );
      await w.playNext();
    }
    expect(w.spoken()).toEqual(order);
  });
});

describe("the queue moving on through the wiring", () => {
  it("starts the oldest queued task when the running one ends, and keeps the rest in order", () => {
    const w = fiveAsked();
    finish(w, "t1");
    expect(runTaskIds(w)).toEqual(["t1", "t2"]);
    expect(w.card("t2")).toMatchObject({
      state: "running",
      line: "Looking into rust.",
    });
    expect(w.card("t3")?.state).toBe("queued");
    expect(w.card("t4")?.state).toBe("queued");
    finish(w, "t2");
    expect(runTaskIds(w)).toEqual(["t1", "t2", "t3"]);
    expect(w.card("t4")?.state).toBe("queued");
  });
});
