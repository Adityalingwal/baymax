import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "../shared/cards";
import { ipcChannels } from "../shared/ipc";
import {
  closePorts,
  heldStep,
  nextTurn,
  startFakeEngine,
  unreachable,
  until,
} from "./tasks/flow.harness";
import { newTask } from "./tasks/harness";
import { failureLine } from "./tasks/lines";
import { failFront, streamFront, wire } from "./wiring.harness";
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

describe("cancel with the models unreachable: a hanging front call", () => {
  it.each(voiceRows)(
    "cancels at once, aborts the call and sends the engine nothing ($name)",
    ({ options, voiceAvailable }) => {
      const w = wire({ ...options, port: startFakeEngine([]).port });
      ask(w, "how does Hermes work?");
      expect(w.talkerCalls).toHaveLength(1);
      cancel(w, "t1");
      expect(w.card("t1")?.state).toBe("cancelled");
      expect(w.port.sent).toEqual([]);
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
      const engine = startFakeEngine([held.call, unreachable]);
      const w = wire({ ...options, port: engine.port });
      ask(w, "tell me hermes");
      await streamFront(w, newTask("hermes"));
      await until("the worker call", () => held.seen.started);
      ask(w, "tell me rust");
      await streamFront(w, newTask("rust"));
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

describe("cancel with the models unreachable: a failed front call", () => {
  it("ends a thinking card whose front call could not reach the models at once", async () => {
    const w = wire({ port: startFakeEngine([]).port });
    ask(w, "how does Hermes work?");
    await failFront(w);
    expect(w.card("t1")).toMatchObject({
      state: "thinking",
      line: failureLine("modelsUnreachable"),
      canRetry: true,
    });
    cancel(w, "t1");
    expect(w.card("t1")?.state).toBe("cancelled");
    expect(w.port.sent).toEqual([]);
    expect(w.failures).toEqual([]);
  });
});
