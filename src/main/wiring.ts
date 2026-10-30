import type { TextStream } from "../providers/anthropic";
import type { EnginePort } from "../shared/engine";
import type { VoicePhase } from "../shared/ipc";
import { forwardFailure, registerRendererActions } from "./renderer-actions";
import type { RendererIpc, RendererSender } from "./renderer-actions";
import { createTalker } from "./talker";
import { createMainState } from "./tasks/state";
import type { MainState, MainStateDeps } from "./tasks/state";
import { frontKey } from "./tasks/talk";
import type { TalkRequest } from "./tasks/talk";
import { createVoice } from "./voice";
import type { Voice, VoiceDeps } from "./voice";

export type WiringDeps = Omit<
  MainStateDeps,
  "send" | "say" | "silence" | "cutFailure" | "talk" | "cancelAttempt"
> & {
  port: EnginePort;
  talkerStream: TextStream | null; // null when there is no Anthropic key
  ipc: RendererIpc;
  isOwnSender: (sender: RendererSender) => boolean;
  fail: (error: unknown) => void; // the restart path
  voice: Omit<VoiceDeps, "timers" | "fail">;
};

export type Wiring = { state: MainState; voice: Voice; close: () => void };

// The screen gets each voice phase as before, and main's state hears it too.
function tellingPhases(
  voice: WiringDeps["voice"],
  told: (phase: VoicePhase) => void,
): WiringDeps["voice"] {
  return {
    ...voice,
    sendVoicePhase: (phase) => {
      voice.sendVoicePhase(phase);
      told(phase);
    },
  };
}

// A typed question's timing starts here, as a spoken one's starts at its release.
function talkThrough(voice: Voice, startCall: (request: TalkRequest) => void) {
  return (request: TalkRequest): void => {
    if (request.kind === "front" && request.utteranceId === null) {
      voice.submitted(frontKey(request));
    }
    startCall(request);
  };
}

// Connects main's state to voice, the engine port and the renderer actions; injected so it runs without Electron.
export function wireMain(deps: WiringDeps): Wiring {
  const { port, ipc, isOwnSender, fail, voice: voiceDeps, ...rest } = deps;
  const { talkerStream, ...stateDeps } = rest;
  let closed = false;
  // Main's state speaks through voice and voice reports to main's state, so voice gets the state once both exist.
  const heard = tellingPhases(voiceDeps, ({ phase }) => {
    // Closing cuts speech, which must not wake a talker call.
    if (closed) return;
    forwardFailure(fail, () => state.setVoiceIdle(phase === "idle"));
  });
  const voice = createVoice({ ...heard, timers: deps.timers, fail });
  const talker = createTalker({
    stream: talkerStream,
    talk: voice.talk,
    onReply: (taskId, attemptId, reply) =>
      forwardFailure(fail, () => state.talkerReplied(taskId, attemptId, reply)),
    timers: deps.timers,
    now: deps.now,
    log: deps.log,
  });
  const state = createMainState({
    ...stateDeps,
    send: (command) => port.send(command),
    say: voice.say,
    silence: voice.silence,
    cutFailure: voice.cutFailure,
    talk: talkThrough(voice, talker.talk),
    cancelAttempt: talker.cancel,
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
  const close = (): void => {
    if (closed) return;
    closed = true;
    removeActions();
    unsubscribe();
    talker.shutdown();
    voice.stop();
    port.close();
  };
  return { state, voice, close };
}
