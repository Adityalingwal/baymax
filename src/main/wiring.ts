import type { EnginePort } from "../shared/engine";
import { forwardFailure, registerRendererActions } from "./renderer-actions";
import type { RendererIpc, RendererSender } from "./renderer-actions";
import { createMainState } from "./tasks/state";
import type { MainState, MainStateDeps } from "./tasks/state";
import { createVoice } from "./voice";
import type { Voice, VoiceDeps } from "./voice";

export type WiringDeps = Omit<MainStateDeps, "send" | "say" | "silence"> & {
  port: EnginePort;
  ipc: RendererIpc;
  isOwnSender: (sender: RendererSender) => boolean;
  fail: (error: unknown) => void; // the restart path
  voice: Omit<VoiceDeps, "timers">;
};

export type Wiring = { state: MainState; voice: Voice; close: () => void };

// Connects main's state to voice, the engine port and the renderer actions; injected so it runs without Electron.
export function wireMain(deps: WiringDeps): Wiring {
  const { port, ipc, isOwnSender, fail, voice: voiceDeps, ...stateDeps } = deps;
  // Main's state speaks through voice and voice reports to main's state, so voice gets the state once both exist.
  const voice = createVoice({ ...voiceDeps, timers: deps.timers });
  const state = createMainState({
    ...stateDeps,
    send: (command) => port.send(command),
    say: voice.say,
    silence: voice.silence,
  });
  voice.start(state);
  // The port only logs a throwing listener, so a state bug is forwarded here.
  const unsubscribe = port.onMessage((event) =>
    forwardFailure(fail, () => state.receive(event)),
  );
  const removeActions = registerRendererActions(
    ipc,
    { state, voice },
    { isOwnSender, fail, log: deps.log },
  );
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    removeActions();
    unsubscribe();
    port.close();
  };
  return { state, voice, close };
}
