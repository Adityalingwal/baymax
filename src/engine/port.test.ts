import { describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type { EngineEvent } from "../shared/engine";
import { startEngine } from "./index";
import { question, questionReply, startTestEngine } from "./harness";

const words = "how does Hermes agent work inside?";

const task = {
  sayBack: "how Hermes works inside",
  startLine: "Okay, looking at how Hermes works.",
  brief: { goal: "g", resultShape: "r", sources: "s", limits: "l" },
};

const cancelled = (taskId: string): EngineEvent => ({
  type: "cancelled",
  taskId,
  findings: null,
});

const cancel = (taskId: string) => ({ type: "cancel" as const, taskId });

describe("startEngine cancel", () => {
  it("stops an intake in flight with one cancelled and nothing else", async () => {
    const engine = startTestEngine(["waitForAbort"]);
    engine.port.send(question(words));
    engine.port.send(cancel("task-1"));
    expect(await engine.settle(1)).toEqual([cancelled("task-1")]);
    expect(await engine.settle(2)).toEqual([cancelled("task-1")]);
  });

  it("answers a cancel for a task not held, after send returns", async () => {
    const engine = startTestEngine([]);
    engine.port.send(cancel("task-5"));
    expect(engine.events).toEqual([]);
    expect(await engine.settle(1)).toEqual([cancelled("task-5")]);
  });

  it("drops a model answer that arrives after its cancel", async () => {
    let answer: (outcome: ModelOutcome) => void = () => undefined;
    const late = new Promise<ModelOutcome>((resolve) => (answer = resolve));
    const engine = startTestEngine([late]);
    engine.port.send(question(words));
    engine.port.send(cancel("task-1"));
    answer(questionReply(task));
    expect(await engine.settle(2)).toEqual([cancelled("task-1")]);
  });
});

describe("startEngine port delivery", () => {
  it("uses the command as sent, whatever the caller changes after", async () => {
    const engine = startTestEngine([questionReply(task)]);
    const command = question(words);
    engine.port.send(command);
    if (command.type === "question") command.words = "changed";
    const [event] = await engine.settle(1);
    expect(event.type === "intake" && event.outcome).toMatchObject({
      brief: { userWords: words },
    });
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
    const engine = startTestEngine([questionReply(task)]);
    engine.port.close();
    engine.port.send(question(words));
    engine.port.send(cancel("task-1"));
    expect(await engine.settle()).toEqual([]);
    expect(engine.requests).toHaveLength(0);
  });

  it("ignores a second command for a task it holds", async () => {
    const engine = startTestEngine(["waitForAbort"]);
    engine.port.send(question(words));
    engine.port.send(question(words));
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
  it("drops the answer of an intake in flight at close", async () => {
    let answer: (outcome: ModelOutcome) => void = () => undefined;
    const pending = new Promise<ModelOutcome>((resolve) => (answer = resolve));
    const engine = startTestEngine([pending]);
    engine.port.send(question(words));
    await engine.settle();
    engine.port.close();
    answer(questionReply(task));
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
        model: async () => ({ ok: false, failure: "error", detail: "boom" }),
        log: () => {
          throw new Error("log broke");
        },
      },
    );
    port.onMessage((event) => events.push(event));
    port.send(question(words));
    port.send(question(words, { taskId: "task-2" }));
    port.send(cancel("task-2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([
      { type: "failure", taskId: "task-1", kind: "error" },
      cancelled("task-2"),
    ]);
  });
});

describe("startEngine command from a listener", () => {
  it("runs a task sent from a listener of that task's intake event", async () => {
    const engine = startTestEngine([questionReply(task), "waitForAbort"]);
    engine.port.onMessage((event) => {
      if (event.type !== "intake") return;
      engine.port.send({
        type: "runTask",
        taskId: event.taskId,
        goalVersion: 1,
        depth: "normal",
        brief: { ...task.brief, userWords: words },
        parent: null,
      });
    });
    engine.port.send(question(words));
    await engine.settle(1);
    expect(engine.requests).toHaveLength(2);
    expect(engine.entries).not.toContainEqual({
      event: "duplicateTask",
      taskId: "task-1",
    });
    engine.port.close();
  });
});
