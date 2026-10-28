import type { Aura, AuraListener } from "../providers/aura";
import type { Synthesis, Transcription } from "../providers/deepgram";
import type { Flux, FluxListener } from "../providers/flux";
import type { TaskId } from "../shared/cards";
import type {
  HoldState,
  MicAudio,
  PlaybackFinished,
  RecordingCommand,
  SpeechChunk,
  SpeechEnd,
  SpeechLine,
  StopPlayback,
} from "../shared/ipc";
import type { HoldOutcome } from "./hold";
import { createRecording } from "./recording";
import type { Heard, NotCaughtCause } from "./recording";
import { createSpeech } from "./speech";
import type { SaidLine, Timers } from "./tasks/state";
import { admit, createModel, setStt, tellHealth } from "./voice-model";
import type { VoiceModel, VoiceState } from "./voice-model";

export type { VoiceState } from "./voice-model";

export type VoiceDeps = {
  sendRecording: (command: RecordingCommand) => void;
  sendSpeech: (line: SpeechLine) => void;
  sendChunk: (chunk: SpeechChunk) => void;
  sendEnd: (end: SpeechEnd) => void;
  sendStop: (payload: StopPlayback) => void;
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<Transcription>;
  startFlux: (listener: FluxListener) => Flux | null; // null when there is no Deepgram key
  synthesize: (text: string, signal: AbortSignal) => Promise<Synthesis>;
  startAura: (listener: AuraListener) => Aura | null; // null when there is no Deepgram key
  timers: Timers;
  now: () => number;
  log: (message: string) => void;
  fail: (error: unknown) => void; // the restart path
  deepgramKeyPresent: boolean;
};

export type Voice = {
  start(state: VoiceState): void;
  holdChanged(holdState: HoldState, outcome: HoldOutcome | null): void;
  micAudio(audio: MicAudio): void;
  playbackFinished(payload: PlaybackFinished): void;
  setMuted(muted: boolean): void;
  say(line: SaidLine): void;
  silence(taskId: TaskId): void;
  rendererReset(): void;
  stop(): void;
};

type Flows = {
  recording: ReturnType<typeof createRecording>;
  speech: ReturnType<typeof createSpeech>;
};

// Voice never throws into main's state or the hold key; a failing call is logged.
function contained(deps: VoiceDeps, name: string, call: () => void): void {
  try {
    call();
  } catch (error: unknown) {
    deps.log(`${name} threw: ${String(error)}`);
  }
}

// A throw from main's state outside an IPC or engine listener is a bug, so it goes to the restart path.
function forwarded(deps: VoiceDeps, call: () => void): void {
  try {
    call();
  } catch (error: unknown) {
    deps.fail(error);
  }
}

function sendRecording(
  model: VoiceModel,
  deps: VoiceDeps,
  command: RecordingCommand,
): void {
  if (command.type === "start") {
    admit(model, command.utteranceId);
    model.current = command.utteranceId;
  } else if (model.current === command.utteranceId) {
    model.current = null;
  }
  contained(deps, "sendRecording", () => deps.sendRecording(command));
}

// The first audio after a release, a whole clip or a streamed chunk, times the first spoken line.
function firstAudio(model: VoiceModel, deps: VoiceDeps): void {
  const releasedAt = model.releasedAt;
  if (releasedAt === null) return;
  model.releasedAt = null;
  const ms = Math.round(deps.now() - releasedAt);
  deps.log(`first spoken line ${ms} ms after release`);
}

function notCaught(
  model: VoiceModel,
  deps: VoiceDeps,
  state: VoiceState,
  cause: NotCaughtCause,
  order: number,
): void {
  switch (cause) {
    case "empty":
      setStt(model, deps.log, true, order);
      return state.showNotice("wordsNotCaught");
    case "error":
      return state.showNotice("wordsNotCaught");
    case "unreachable":
    case "keyRejected":
    case "noCredit":
      return setStt(model, deps.log, false, order);
    case "permissionDenied":
      return state.showNotice("micBlocked");
    case "noMicrophone":
      return state.showNotice("noMicrophone");
  }
}

function receiveHeard(model: VoiceModel, deps: VoiceDeps, heard: Heard) {
  const entry = model.admitted.get(heard.utteranceId);
  const state = model.state;
  if (entry === undefined || state === null) {
    deps.log(`${heard.kind} dropped: utterance not admitted`);
    return;
  }
  model.admitted.delete(heard.utteranceId);
  if (entry.releasedAt !== null) {
    const ms = Math.round(deps.now() - entry.releasedAt);
    deps.log(`final transcript ${ms} ms after release`);
  }
  if (heard.kind === "notCaught") {
    return notCaught(model, deps, state, heard.cause, entry.order);
  }
  setStt(model, deps.log, true, entry.order);
  state.ask(heard.words, heard.utteranceId, entry.waiting);
}

function holdChanged(
  model: VoiceModel,
  deps: VoiceDeps,
  flows: Flows,
  change: { holdState: HoldState; outcome: HoldOutcome | null },
): void {
  model.held = change.holdState === "listening";
  if (model.held) {
    model.releasedAt = null;
    // Recording discards a hold still open when a new one starts.
    if (model.current !== null) model.admitted.delete(model.current);
    flows.speech.holdStarted();
    flows.recording.holdStarted();
    return;
  }
  const outcome = change.outcome;
  if (outcome === null) return;
  const ending = model.current;
  flows.recording.holdEnded(outcome);
  if (outcome === "discard" && ending !== null) model.admitted.delete(ending);
  if (outcome === "accept") {
    model.releasedAt = deps.now();
    const entry = ending === null ? undefined : model.admitted.get(ending);
    if (entry !== undefined) entry.releasedAt = model.releasedAt;
  }
  flows.speech.holdEnded();
}

function createFlows(model: VoiceModel, deps: VoiceDeps): Flows {
  const recording = createRecording({
    sendRecording: (command) => sendRecording(model, deps, command),
    startFlux: deps.startFlux,
    transcribe: deps.transcribe,
    timers: deps.timers,
    log: deps.log,
    onHeard: (heard) => forwarded(deps, () => receiveHeard(model, deps, heard)),
  });
  const speech = createSpeech({
    synthesize: deps.synthesize,
    startAura: deps.startAura,
    sendSpeech: (line) => {
      firstAudio(model, deps);
      deps.sendSpeech(line);
    },
    sendChunk: (chunk) => {
      firstAudio(model, deps);
      deps.sendChunk(chunk);
    },
    sendEnd: deps.sendEnd,
    sendStop: deps.sendStop,
    onVoiceAvailable: (available) => {
      model.ttsUp = available;
      forwarded(deps, () => tellHealth(model));
    },
    timers: deps.timers,
  });
  return { recording, speech };
}

function forgetRenderer(model: VoiceModel, flows: Flows): void {
  flows.recording.rendererReset();
  flows.speech.rendererReset();
  model.admitted.clear();
  model.current = null;
  // The key may still be down, and nothing may be spoken while it is.
  if (model.held) flows.speech.holdStarted();
}

// Restarting: the open recording ends, late transcripts are dropped, and speech may still say the restart line.
function stopVoice(model: VoiceModel, flows: Flows): void {
  if (model.stopped) return;
  model.stopped = true;
  flows.recording.stop();
  model.admitted.clear();
  model.current = null;
  model.held = false;
  flows.speech.holdEnded();
}

// Joins recording and speech to main's state; main's state is built with say and silence first, then given here by start.
export function createVoice(deps: VoiceDeps): Voice {
  const model = createModel();
  const flows = createFlows(model, deps);
  const { recording, speech } = flows;
  const withState = (name: string, call: (state: VoiceState) => void) => {
    const state = model.state;
    if (state === null) return deps.log(`${name} before start: ignored`);
    if (model.stopped) return deps.log(`${name} after stop: ignored`);
    call(state);
  };
  return {
    start: (state) => {
      model.state = state;
      model.sttUp = deps.deepgramKeyPresent;
      tellHealth(model);
    },
    holdChanged: (holdState, outcome) =>
      withState("hold change", () =>
        holdChanged(model, deps, flows, { holdState, outcome }),
      ),
    micAudio: (audio) =>
      withState("mic audio", () => recording.micAudio(audio)),
    playbackFinished: (payload) => speech.playbackFinished(payload),
    setMuted: (muted) =>
      withState("mute", (state) => {
        try {
          state.setMuted(muted);
        } finally {
          speech.setMuted(muted);
        }
      }),
    say: (line) => contained(deps, "say", () => speech.speak(line)),
    silence: (taskId) =>
      contained(deps, "silence", () => speech.cancelTask(taskId)),
    rendererReset: () => forgetRenderer(model, flows),
    stop: () => stopVoice(model, flows),
  };
}
