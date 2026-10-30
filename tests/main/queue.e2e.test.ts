import { describe, expect, it } from "vitest";
import type { TaskId } from "../../src/shared/cards";
import { admitAs, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

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
    findings: { cardText: "Found.", sources: [] },
  });

describe("five typed questions through the wiring", () => {
  it("runs the first and queues the rest, even past the limit, since each line was already spoken", async () => {
    const w = await fiveAsked();
    expect(runTaskIds(w)).toEqual(["t1"]);
    expect(w.card("t1")).toMatchObject({
      state: "running",
      line: null,
    });
    for (const taskId of ["t2", "t3", "t4", "t5"]) {
      expect(w.card(taskId)).toMatchObject({ state: "queued", line: null });
    }
    expect(w.failures).toEqual([]);
  });
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("speech for five typed questions", () => {
  it("says each front line and no fixed queue line", async () => {
    const w = await fiveAsked();
    await flush();
    await w.playAll();
    expect(w.stops).toEqual([]);
    expect(w.spoken()).toEqual(names.map((name) => `Checking ${name}.`));
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
      findings: { cardText: "Done.", sources: [] },
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
      line: null,
    });
    expect(w.card("t3")?.state).toBe("queued");
    expect(w.card("t4")?.state).toBe("queued");
    finish(w, "t2");
    expect(runTaskIds(w)).toEqual(["t1", "t2", "t3"]);
    expect(w.card("t4")?.state).toBe("queued");
  });
});
