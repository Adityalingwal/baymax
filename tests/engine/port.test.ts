import { describe, expect, it } from "vitest";
import type { ModelOutcome } from "../../src/providers/anthropic";
import type { EngineEvent } from "../../src/shared/engine";
import { startEngine } from "../../src/engine/index";
import { startTestEngine } from "./harness";
import { ask, runTask, workerAnswer } from "./run.harness";

const failedCall: ModelOutcome = { ok: false, failure: "error", detail: "x" };

const cancelled = (taskId: string): EngineEvent => ({
  type: "cancelled",
  taskId,
  findings: null,
});

const cancel = (taskId: string) => ({ type: "cancel" as const, taskId });

describe("startEngine port delivery", () => {
  it("uses the command as sent, whatever the caller changes after", async () => {
    const engine = startTestEngine(["waitForAbort"]);
    const command = { ...runTask(), ask: { ...ask } };
    engine.port.send(command);
    command.ask.goal = "changed";
    await engine.settle();
    expect(JSON.stringify(engine.requests[0].messages)).toContain(ask.goal);
    engine.port.close();
  });

  it("gives each listener its own copy of an event", async () => {
    const engine = startTestEngine([]);
    const seen: EngineEvent[] = [];
    engine.port.onMessage((event) => {
      if (event.type === "cancelled") event.taskId = "mutated";
    });
    engine.port.onMessage((event) => seen.push(event));
    engine.port.send(cancel("task-1"));
    await engine.settle(1);
    expect(seen).toEqual([cancelled("task-1")]);
  });

  it("stops delivery to a listener whose cleanup ran, even before a deferred delivery", async () => {
    const engine = startTestEngine([]);
    const before: EngineEvent[] = [];
    const during: EngineEvent[] = [];
    engine.port.onMessage((event) => before.push(event))();
    const stop = engine.port.onMessage((event) => during.push(event));
    engine.port.send(cancel("task-1"));
    stop();
    expect(await engine.settle(1)).toHaveLength(1);
    expect([before, during]).toEqual([[], []]);
  });
});

describe("startEngine port lifecycle", () => {
  it("stops delivery after a listener closes the port", async () => {
    const engine = startTestEngine([]);
    const after: EngineEvent[] = [];
    engine.port.onMessage(() => engine.port.close());
    engine.port.onMessage((event) => after.push(event));
    engine.port.send(cancel("task-1"));
    expect(await engine.settle(1)).toHaveLength(1);
    expect(after).toEqual([]);
  });

  it("keeps delivering when a listener throws", async () => {
    const engine = startTestEngine([]);
    const after: EngineEvent[] = [];
    engine.port.onMessage(() => {
      throw new Error("listener broke");
    });
    engine.port.onMessage((event) => after.push(event));
    engine.port.send(cancel("task-1"));
    await engine.settle(1);
    expect(after).toEqual([cancelled("task-1")]);
    expect(engine.entries).toContainEqual({
      event: "listenerError",
      message: "listener broke",
    });
  });

  it("does nothing after close", async () => {
    const engine = startTestEngine([failedCall]);
    engine.port.close();
    engine.port.send(runTask());
    engine.port.send(cancel("task-1"));
    expect(await engine.settle()).toEqual([]);
    expect(engine.requests).toHaveLength(0);
  });
});

describe("startEngine holds", () => {
  it("releases the hold of a thrown run, so the same task id runs again", async () => {
    const thrown = Promise.reject(new Error("boom"));
    thrown.catch(() => undefined);
    const engine = startTestEngine([thrown, failedCall]);
    engine.port.send(runTask());
    const errorEnd: EngineEvent = {
      type: "failed",
      taskId: "task-1",
      cause: "error",
      reason: null,
      findings: null,
    };
    expect(await engine.settle(1)).toEqual([errorEnd]);
    engine.port.send(runTask());
    expect(await engine.settle(2)).toEqual([errorEnd, errorEnd]);
    expect(engine.requests).toHaveLength(2);
    expect(engine.entries).toContainEqual(
      expect.objectContaining({ event: "taskEnd", how: "thrown" }),
    );
  });

  it("ignores a second command for a task it holds", async () => {
    const engine = startTestEngine(["waitForAbort"]);
    engine.port.send(runTask());
    engine.port.send(runTask());
    await engine.settle();
    expect(engine.requests).toHaveLength(1);
    expect(engine.entries).toContainEqual({
      event: "duplicateTask",
      taskId: "task-1",
    });
    engine.port.close();
  });
});

describe("startEngine robustness", () => {
  it("drops the answer of a run in flight at close", async () => {
    let answer: (outcome: ModelOutcome) => void = () => undefined;
    const pending = new Promise<ModelOutcome>((resolve) => (answer = resolve));
    const engine = startTestEngine([pending]);
    engine.port.send(runTask());
    await engine.settle();
    engine.port.close();
    answer(workerAnswer());
    expect(await engine.settle()).toEqual([]);
    expect(engine.requests).toHaveLength(1);
  });

  it("never throws on a malformed command and logs it", async () => {
    const engine = startTestEngine([]);
    const send = engine.port.send;
    expect(() => Reflect.apply(send, undefined, [undefined])).not.toThrow();
    Reflect.apply(send, undefined, [{ type: "steer", taskId: "task-1" }]);
    expect(await engine.settle()).toEqual([]);
    expect(engine.entries).toEqual([
      {
        event: "commandError",
        taskId: null,
        message: "command is not an object",
      },
      { event: "unknownCommand", taskId: null },
    ]);
  });
});

describe("startEngine dev log", () => {
  it("still answers when the dev log throws", async () => {
    const events: EngineEvent[] = [];
    const port = startEngine(
      { anthropicKey: "test-key", searchKey: "" },
      {
        model: async () => failedCall,
        log: () => {
          throw new Error("log broke");
        },
      },
    );
    port.onMessage((event) => events.push(event));
    port.send(runTask());
    port.send(runTask({ taskId: "task-2" }));
    port.send(cancel("task-2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([
      {
        type: "failed",
        taskId: "task-1",
        cause: "error",
        reason: null,
        findings: null,
      },
      cancelled("task-2"),
    ]);
  });

  it("logs each call by task and role, without the key or the words", async () => {
    const engine = startTestEngine([failedCall, failedCall]);
    engine.port.send(runTask());
    engine.port.send(runTask({ taskId: "task-2" }));
    await engine.settle(2);
    const calls = engine.entries.filter((entry) => entry.event === "modelCall");
    expect(calls).toHaveLength(2);
    for (const taskId of ["task-1", "task-2"]) {
      expect(calls).toContainEqual(
        expect.objectContaining({ taskId, role: "worker" }),
      );
    }
    const logged = JSON.stringify(engine.entries);
    expect(logged).not.toContain("test-key");
    expect(logged).not.toContain(ask.userWords);
  });
});

describe("startEngine command from a listener", () => {
  it("runs a task sent from a listener of that task's last event, and holds and cancels it", async () => {
    const engine = startTestEngine([failedCall, "waitForAbort"]);
    let resent = false;
    engine.port.onMessage((event) => {
      if (event.type !== "failed" || resent) return;
      resent = true;
      engine.port.send(runTask());
    });
    engine.port.send(runTask());
    await engine.settle(1);
    expect(engine.requests).toHaveLength(2);
    expect(engine.entries).not.toContainEqual({
      event: "duplicateTask",
      taskId: "task-1",
    });
    // The first run's cleanup must not drop the second run's hold: a third run is refused and cancel reaches the second.
    engine.port.send(runTask());
    expect(engine.entries).toContainEqual({
      event: "duplicateTask",
      taskId: "task-1",
    });
    engine.port.send(cancel("task-1"));
    const events = await engine.settle(2);
    expect(events.map((event) => event.type)).toEqual(["failed", "cancelled"]);
    expect(engine.requests).toHaveLength(2);
    engine.port.close();
  });
});
