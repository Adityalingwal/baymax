import { describe, expect, it } from "vitest";
import type { EngineCommand } from "../shared/engine";
import { ipcChannels } from "../shared/ipc";
import { findings, intake, newTask } from "./tasks/harness";
import { runToDone, source, submit, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const throwRows = [
  {
    name: "a renderer action",
    options: { idFails: true },
    act: submit,
    message: "no task id",
  },
  {
    name: "a port event",
    options: {
      sendFails: (command: EngineCommand) => command.type === "runTask",
    },
    act: (w: Wired) => {
      submit(w);
      w.port.emit(intake("t1", newTask("how Hermes works")));
    },
    message: "send runTask broke",
  },
];

describe("wireMain typed path", () => {
  it("carries a typed question to a checked answer card with sources", () => {
    const w = wire();
    submit(w);
    expect(w.port.sent).toMatchObject([
      {
        type: "question",
        taskId: "t1",
        utteranceId: null,
        words: "how does Hermes work?",
        waiting: null,
      },
    ]);
    expect(w.card("t1")?.state).toBe("thinking");
    w.port.emit(intake("t1", newTask("how Hermes works")));
    expect(w.port.sent.at(-1)).toMatchObject({ type: "runTask", taskId: "t1" });
    expect(w.card("t1")).toMatchObject({
      state: "running",
      line: "Looking into how Hermes works.",
    });
    w.port.emit({
      type: "progress",
      taskId: "t1",
      step: { tool: "search", query: "Hermes agent internals" },
      sourcesRead: 1,
    });
    expect(w.card("t1")).toMatchObject({
      step: "searching: Hermes agent internals",
      sourcesRead: 1,
    });
    w.port.emit({
      type: "result",
      taskId: "t1",
      spokenLine: "Hermes runs a loop.",
      findings: findings("Hermes runs a loop.", [source]),
    });
    expect(w.card("t1")).toMatchObject({
      state: "done",
      answer: { cardText: "Hermes runs a loop.", sources: [{ url: source }] },
    });
    expect(w.failures).toEqual([]);
  });
});

describe("wireMain replay, failures and close", () => {
  it("replays the current display state to the asking window", () => {
    const w = wire();
    runToDone(w);
    w.send(ipcChannels.getDisplayState);
    expect(w.own.received).toEqual([
      [ipcChannels.displayState, w.wiring.state.displayState()],
    ]);
    expect(w.own.received[0][1].tasks[0].state).toBe("done");
  });

  it.each(throwRows)(
    "forwards a state throw from $name to fail once",
    ({ options, act, message }) => {
      const w = wire(options);
      expect(() => act(w)).not.toThrow();
      expect(w.failures).toHaveLength(1);
      expect(String(w.failures[0])).toContain(message);
    },
  );

  it("close removes every listener, unsubscribes and closes the port once", () => {
    const w = wire();
    submit(w);
    expect(w.ipc.count()).toBe(9);
    expect(w.port.listeners()).toBe(1);
    w.wiring.close();
    expect(w.ipc.count()).toBe(0);
    expect(w.ipc.removals()).toBe(9);
    expect(w.port.listeners()).toBe(0);
    expect(w.port.closes()).toBe(1);
    const published = w.published.length;
    w.port.emit(intake("t1", newTask("how Hermes works")));
    w.send(ipcChannels.setMuted, { muted: true });
    expect(w.published).toHaveLength(published);
    expect(w.port.sent).toHaveLength(1);
    w.wiring.close();
    expect(w.ipc.removals()).toBe(9);
    expect(w.port.closes()).toBe(1);
  });
});
