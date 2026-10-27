import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "../shared/cards";
import { ipcChannels } from "../shared/ipc";
import {
  closePorts,
  heldStep,
  newTaskReply,
  nextTurn,
  startFakeEngine,
  unreachable,
  until,
} from "./tasks/flow.harness";
import { failureLine } from "./tasks/lines";
import { wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

afterEach(closePorts);

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

const cancel = (w: Wired, taskId: TaskId) =>
  w.send(ipcChannels.cancelTask, { taskId });

const runSent = (w: Wired, taskId: TaskId) =>
  w.port.sent.some((c) => c.type === "runTask" && c.taskId === taskId);

// Ten turns cover the engine's own deferred deliveries; a later event would need a timer, which the fakes never set.
async function expectOneCancelledLast(w: Wired, taskId: TaskId) {
  for (let turn = 0; turn < 10; turn += 1) await nextTurn();
  const events = w.port.events.filter((event) => event.taskId === taskId);
  expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("cancelled");
}

const voiceRows = [
  { name: "voice working", options: {}, voiceAvailable: true },
  {
    name: "voice down as well",
    options: { deepgramKeyPresent: false, voiceFails: true },
    voiceAvailable: false,
  },
];

describe("cancel with the models unreachable: a hanging intake call", () => {
  it.each(voiceRows)(
    "stays cancelling until the call ends ($name)",
    async ({ options, voiceAvailable }) => {
      const held = heldStep();
      const w = wire({ ...options, port: startFakeEngine([held.call]).port });
      ask(w, "how does Hermes work?");
      await until("the intake call", () => held.seen.started);
      cancel(w, "t1");
      expect(w.card("t1")?.state).toBe("cancelling");
      await until("the abort", () => held.seen.aborted);
      await nextTurn();
      expect(w.card("t1")?.state).toBe("cancelling");
      held.release();
      await until(
        "the cancelled card",
        () => w.card("t1")?.state === "cancelled",
      );
      await expectOneCancelledLast(w, "t1");
      expect(w.published.at(-1)?.voiceAvailable).toBe(voiceAvailable);
      expect(w.failures).toEqual([]);
    },
  );
});

describe("cancel with the models unreachable: a hanging worker call", () => {
  it.each(voiceRows)(
    "keeps the queued task waiting until the run has really ended ($name)",
    async ({ options, voiceAvailable }) => {
      const held = heldStep();
      const engine = startFakeEngine([
        newTaskReply("hermes"),
        held.call,
        newTaskReply("rust"),
        unreachable,
      ]);
      const w = wire({ ...options, port: engine.port });
      ask(w, "tell me hermes");
      await until("the worker call", () => held.seen.started);
      ask(w, "tell me rust");
      await until("the queued card", () => w.card("t2")?.state === "queued");
      cancel(w, "t1");
      expect(w.card("t1")?.state).toBe("cancelling");
      await until("the abort", () => held.seen.aborted);
      await nextTurn();
      expect(w.card("t1")?.state).toBe("cancelling");
      expect(runSent(w, "t2")).toBe(false);
      held.release();
      await until("the next run", () => runSent(w, "t2"));
      const firstRunning = w.published.find(
        (display) =>
          display.tasks.find((card) => card.taskId === "t2")?.state ===
          "running",
      );
      expect(
        firstRunning?.tasks.find((card) => card.taskId === "t1")?.state,
      ).toBe("cancelled");
      await expectOneCancelledLast(w, "t1");
      expect(w.published.at(-1)?.voiceAvailable).toBe(voiceAvailable);
      expect(w.failures).toEqual([]);
    },
  );
});

describe("cancel with the models unreachable: a failed intake", () => {
  it("ends a thinking card whose intake could not reach the models at once", async () => {
    const w = wire({ port: startFakeEngine([unreachable]).port });
    ask(w, "how does Hermes work?");
    await until("the failure line", () => w.card("t1")?.canRetry === true);
    expect(w.card("t1")).toMatchObject({
      state: "thinking",
      line: failureLine("modelsUnreachable"),
      canRetry: true,
    });
    cancel(w, "t1");
    expect(w.card("t1")?.state).toBe("cancelled");
    expect(w.port.sent.map((command) => command.type)).toEqual(["question"]);
    expect(w.failures).toEqual([]);
  });
});
