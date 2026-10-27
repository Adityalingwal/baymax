import type {
  EngineCommand,
  EngineEvent,
  EnginePort,
} from "../../shared/engine";
import type { DevLog } from "./dev-log";

type Listener = (event: EngineEvent) => void;
type Subscription = { listener: Listener; active: boolean };

export type PortSide = {
  port: EnginePort;
  emit: (event: EngineEvent) => void; // delivers now; for the engine's async continuations
  emitLater: (event: EngineEvent) => void; // delivers in a microtask; for events that originate inside send
};

export type PortDeps = {
  log: DevLog;
  receive: (command: EngineCommand) => void;
  close: () => void;
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Only JSON crosses the port, as it will when the engine moves to its own process.
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

type PortState = { closed: boolean; subscriptions: Subscription[] };

// Re-checks before each listener, so a listener that closes the port or unsubscribes another stops later deliveries.
function deliver(
  state: PortState,
  log: DevLog,
  event: EngineEvent,
  targets: Subscription[],
): void {
  for (const target of targets) {
    if (state.closed || !target.active) continue;
    try {
      target.listener(jsonCopy(event));
    } catch (error) {
      log({ event: "listenerError", message: messageOf(error) });
    }
  }
}

export function createPort(deps: PortDeps): PortSide {
  const state: PortState = { closed: false, subscriptions: [] };

  const emit = (event: EngineEvent): void => {
    if (state.closed) return;
    deliver(state, deps.log, event, [...state.subscriptions]);
  };

  const emitLater = (event: EngineEvent): void => {
    if (state.closed) return;
    const targets = [...state.subscriptions];
    queueMicrotask(() => deliver(state, deps.log, event, targets));
  };

  const send = (command: EngineCommand): void => {
    if (state.closed) return;
    try {
      deps.receive(jsonCopy(command));
    } catch (error) {
      const taskId = typeof command.taskId === "string" ? command.taskId : null;
      deps.log({ event: "commandError", taskId, message: messageOf(error) });
    }
  };

  const onMessage = (listener: Listener): (() => void) => {
    const subscription = { listener, active: true };
    state.subscriptions.push(subscription);
    return () => {
      subscription.active = false;
      state.subscriptions = state.subscriptions.filter(
        (other) => other !== subscription,
      );
    };
  };

  const close = (): void => {
    if (state.closed) return;
    state.closed = true;
    for (const subscription of state.subscriptions) subscription.active = false;
    state.subscriptions = [];
    deps.close();
  };

  return { port: { send, onMessage, close }, emit, emitLater };
}
