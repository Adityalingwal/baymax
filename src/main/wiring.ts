import type { EnginePort } from "../shared/engine";
import { forwardFailure, registerRendererActions } from "./renderer-actions";
import type { RendererIpc, RendererSender } from "./renderer-actions";
import { createMainState } from "./tasks/state";
import type { MainState, MainStateDeps } from "./tasks/state";

export type WiringDeps = Omit<MainStateDeps, "send"> & {
  port: EnginePort;
  ipc: RendererIpc;
  isOwnSender: (sender: RendererSender) => boolean;
  fail: (error: unknown) => void; // the restart path
};

export type Wiring = { state: MainState; close: () => void };

// Connects main's state to the engine port and the renderer actions; injected so it runs without Electron.
export function wireMain(deps: WiringDeps): Wiring {
  const { port, ipc, isOwnSender, fail, ...stateDeps } = deps;
  const state = createMainState({
    ...stateDeps,
    send: (command) => port.send(command),
  });
  // The port only logs a throwing listener, so a state bug is forwarded here.
  const unsubscribe = port.onMessage((event) =>
    forwardFailure(fail, () => state.receive(event)),
  );
  const removeActions = registerRendererActions(ipc, state, {
    isOwnSender,
    fail,
    log: deps.log,
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    removeActions();
    unsubscribe();
    port.close();
  };
  return { state, close };
}
