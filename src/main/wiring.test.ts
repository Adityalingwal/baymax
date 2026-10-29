import { describe, expect, it } from "vitest";
import type { EngineCommand } from "../shared/engine";
import { ipcChannels } from "../shared/ipc";
import { findings, newTask } from "./tasks/harness";
import { runToDone, source, streamFront, submit, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const throwRows = [
  {
    name: "a renderer action",
    options: { idFails: true },
    act: submit,
    message: "no task id",
  },
  {
    name: "a front reply",
    options: {
      sendFails: (command: EngineCommand) => command.type === "runTask",
    },
    act: async (w: Wired) => {
      submit(w);
      await streamFront(w, newTask("how Hermes works"));
    },
    message: "send runTask broke",
  },
];

describe("wireMain typed path", () => {
  it("carries a typed question to a checked answer card with sources", async () => {
    const w = wire();
    submit(w);
    expect(w.port.sent).toEqual([]);
    expect(w.talkerCalls).toHaveLength(1);
    expect(JSON.stringify(w.talkerCalls[0].request.messages)).toContain(
      "how does Hermes work?",
    );
    expect(w.card("t1")?.state).toBe("thinking");
    await streamFront(w, newTask("how Hermes works"), "I'll look into Hermes.");
    expect(w.port.sent.at(-1)).toMatchObject({ type: "runTask", taskId: "t1" });
    expect(w.card("t1")).toMatchObject({
      state: "running",
      reply: "I'll look into Hermes.",
      line: null,
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
  it("replays the current display state to the asking window", async () => {
    const w = wire();
    await runToDone(w);
    w.send(ipcChannels.getDisplayState);
    expect(w.own.received).toEqual([
      [ipcChannels.displayState, w.wiring.state.displayState()],
    ]);
    expect(w.own.received[0][1].tasks[0].state).toBe("done");
  });

  it.each(throwRows)(
    "forwards a state throw from $name to fail once",
    async ({ options, act, message }) => {
      const w = wire(options);
      await expect(Promise.resolve(act(w))).resolves.not.toThrow();
      expect(w.failures).toHaveLength(1);
      expect(String(w.failures[0])).toContain(message);
    },
  );

  it("close removes every listener, unsubscribes and closes the port once, and a late front reply changes nothing", async () => {
    const w = wire();
    submit(w);
    expect(w.ipc.count()).toBe(11);
    expect(w.port.listeners()).toBe(1);
    w.wiring.close();
    expect(w.ipc.count()).toBe(0);
    expect(w.ipc.removals()).toBe(11);
    expect(w.port.listeners()).toBe(0);
    expect(w.port.closes()).toBe(1);
    const published = w.published.length;
    await streamFront(w, newTask("how Hermes works"));
    w.send(ipcChannels.setMuted, { muted: true });
    expect(w.published).toHaveLength(published);
    expect(w.port.sent).toHaveLength(0);
    w.wiring.close();
    expect(w.ipc.removals()).toBe(11);
    expect(w.port.closes()).toBe(1);
  });
});
