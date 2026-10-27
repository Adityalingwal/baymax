import type { DisplayState, TaskId } from "../shared/cards";
import type { EngineCommand, EngineEvent, EnginePort } from "../shared/engine";
import { ipcChannels } from "../shared/ipc";
import type { RendererListener, RendererSender } from "./renderer-actions";
import { createClock, findings, intake, newTask } from "./tasks/harness";
import { wireMain } from "./wiring";

type Options = {
  sendFails?: (command: EngineCommand) => boolean;
  idFails?: boolean;
};

function fakePort(sendFails: (command: EngineCommand) => boolean) {
  const sent: EngineCommand[] = [];
  let listeners: ((event: EngineEvent) => void)[] = [];
  let closes = 0;
  const port: EnginePort = {
    send: (command) => {
      if (sendFails(command)) throw new Error(`send ${command.type} broke`);
      sent.push(command);
    },
    onMessage: (listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((other) => other !== listener);
      };
    },
    // Counts only, so a test can tell the wiring's own unsubscribe from the port's.
    close: () => {
      closes += 1;
    },
  };
  return {
    port,
    sent,
    emit: (event: EngineEvent) => [...listeners].forEach((l) => l(event)),
    listeners: () => listeners.length,
    closes: () => closes,
  };
}

function fakeIpc() {
  const listeners = new Map<string, RendererListener[]>();
  let removals = 0;
  const ipc = {
    on: (channel: string, listener: RendererListener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
    removeListener: (channel: string, listener: RendererListener) => {
      removals += 1;
      const rest = (listeners.get(channel) ?? []).filter((l) => l !== listener);
      listeners.set(channel, rest);
    },
  };
  const call = (channel: string, payload: unknown, sender: RendererSender) =>
    (listeners.get(channel) ?? []).forEach((l) => l({ sender }, payload));
  const count = () =>
    [...listeners.values()].reduce((total, list) => total + list.length, 0);
  return { ipc, call, count, removals: () => removals };
}

export function fakeSender() {
  const received: [string, DisplayState][] = [];
  const sender: RendererSender = {
    send: (channel, display) => received.push([channel, display]),
  };
  return { sender, received };
}

export function wire(options: Options = {}) {
  const clock = createClock();
  const port = fakePort(options.sendFails ?? (() => false));
  const ipc = fakeIpc();
  const own = fakeSender();
  const seen = {
    published: [] as DisplayState[],
    opened: [] as string[],
    logs: [] as string[],
    failures: [] as unknown[],
  };
  let ids = 0;
  const wiring = wireMain({
    port: port.port,
    ipc: ipc.ipc,
    isOwnSender: (sender) => sender === own.sender,
    publish: (display) => seen.published.push(display),
    say: () => undefined,
    openUrl: (url) => {
      seen.opened.push(url);
      return Promise.resolve();
    },
    log: (message) => seen.logs.push(message),
    timers: { setTimer: clock.setTimer },
    newTaskId: () => {
      if (options.idFails) throw new Error("no task id");
      ids += 1;
      return `t${ids}`;
    },
    fail: (error) => seen.failures.push(error),
  });
  const send = (channel: string, payload?: unknown, sender = own.sender) =>
    ipc.call(channel, payload, sender);
  const card = (taskId: TaskId) =>
    seen.published.at(-1)?.tasks.find((shown) => shown.taskId === taskId);
  return { ...seen, wiring, port, ipc, own, send, card };
}

export type Wired = ReturnType<typeof wire>;

export const source = "https://example.com/hermes";

export function submit(w: Wired): void {
  w.send(ipcChannels.submitQuestion, { text: "  how does Hermes work?  " });
}

export function admitTask(w: Wired): void {
  submit(w);
  w.port.emit(intake("t1", newTask("how Hermes works")));
}

export function runToDone(w: Wired): void {
  admitTask(w);
  w.port.emit({
    type: "result",
    taskId: "t1",
    spokenLine: "Hermes runs a loop.",
    findings: findings("Hermes runs a loop.", [source]),
  });
}
