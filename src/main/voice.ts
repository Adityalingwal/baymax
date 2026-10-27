import type { Synthesis, Transcription } from "../providers/deepgram";
import type { TaskId, UtteranceId } from "../shared/cards";
import type { WaitingQuestion } from "../shared/engine";
import type {
  Clip,
  HoldState,
  PlaybackFinished,
  RecordingCommand,
  SpeechLine,
  StopPlayback,
} from "../shared/ipc";
import type { HoldOutcome } from "./hold";
import { createRecording } from "./recording";
import type { Heard, NotCaughtCause } from "./recording";
import { createSpeech } from "./speech";
import type { MainState, SaidLine, Timers } from "./tasks/state";

export type VoiceState = Pick<
  MainState,
  "ask" | "waitingQuestion" | "setMuted" | "setVoiceAvailable" | "showNotice"
>;

export type VoiceDeps = {
  sendRecording: (command: RecordingCommand) => void;
  sendSpeech: (line: SpeechLine) => void;
  sendStop: (payload: StopPlayback) => void;
  transcribe: (audio: ArrayBuffer, mimeType: string) => Promise<Transcription>;
  synthesize: (text: string, signal: AbortSignal) => Promise<Synthesis>;
  timers: Timers;
  now: () => number;
  log: (message: string) => void;
  deepgramKeyPresent: boolean;
};

export type Voice = {
  start(state: VoiceState): void;
  holdChanged(holdState: HoldState, outcome: HoldOutcome | null): void;
  clipArrived(clip: Clip): void;
  playbackFinished(payload: PlaybackFinished): void;
  setMuted(muted: boolean): void;
  say(line: SaidLine): void;
  silence(taskId: TaskId): void;
  rendererReset(): void;
};

// The waiting question at key-down and the hold's place in time, kept until its words are delivered.
type Admitted = { waiting: WaitingQuestion | null; order: number };

type VoiceModel = {
  state: VoiceState | null;
  admitted: Map<UtteranceId, Admitted>;
  nextOrder: number;
  current: UtteranceId | null;
  sttUp: boolean;
  sttOrder: number;
  ttsUp: boolean;
  told: boolean;
  releasedAt: number | null;
};

type Flows = {
  recording: ReturnType<typeof createRecording>;
  speech: ReturnType<typeof createSpeech>;
};

const admittedLimit = 16;

// Voice never throws into main's state or the hold key; a failing call is logged.
function contained(deps: VoiceDeps, name: string, call: () => void): void {
  try {
    call();
  } catch (error: unknown) {
    deps.log(`${name} threw: ${String(error)}`);
  }
}

function admit(model: VoiceModel, utteranceId: UtteranceId): void {
  const waiting = model.state?.waitingQuestion() ?? null;
  model.admitted.set(utteranceId, { waiting, order: model.nextOrder });
  model.nextOrder += 1;
  if (model.admitted.size <= admittedLimit) return;
  const oldest = model.admitted.keys().next();
  if (oldest.done !== true) model.admitted.delete(oldest.value);
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

function sendSpeech(model: VoiceModel, deps: VoiceDeps, line: SpeechLine) {
  const releasedAt = model.releasedAt;
  if (releasedAt !== null) {
    model.releasedAt = null;
    const ms = Math.round(deps.now() - releasedAt);
    deps.log(`first spoken line ${ms} ms after release`);
  }
  deps.sendSpeech(line);
}

function tellHealth(model: VoiceModel): void {
  const up = model.sttUp && model.ttsUp;
  const state = model.state;
  if (state === null || up === model.told) return;
  model.told = up;
  state.setVoiceAvailable(up);
}

// An older utterance's result arriving late never overrides a newer one's.
function setStt(
  model: VoiceModel,
  deps: VoiceDeps,
  up: boolean,
  order: number,
) {
  if (order <= model.sttOrder) {
    deps.log("an older transcript result left STT health as it was");
    return;
  }
  model.sttOrder = order;
  model.sttUp = up;
  tellHealth(model);
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
      setStt(model, deps, true, order);
      return state.showNotice("wordsNotCaught");
    case "error":
      return state.showNotice("wordsNotCaught");
    case "unreachable":
    case "keyRejected":
    case "noCredit":
      return setStt(model, deps, false, order);
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
  if (heard.kind === "notCaught") {
    return notCaught(model, deps, state, heard.cause, entry.order);
  }
  setStt(model, deps, true, entry.order);
  state.ask(heard.words, heard.utteranceId, entry.waiting);
}

function holdChanged(
  model: VoiceModel,
  deps: VoiceDeps,
  flows: Flows,
  change: { holdState: HoldState; outcome: HoldOutcome | null },
): void {
  if (change.holdState === "listening") {
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
  if (outcome === "accept") model.releasedAt = deps.now();
  flows.speech.holdEnded();
}

function createFlows(model: VoiceModel, deps: VoiceDeps): Flows {
  const recording = createRecording({
    sendRecording: (command) => sendRecording(model, deps, command),
    transcribe: deps.transcribe,
    onHeard: (heard) => receiveHeard(model, deps, heard),
  });
  const speech = createSpeech({
    synthesize: deps.synthesize,
    sendSpeech: (line) => sendSpeech(model, deps, line),
    sendStop: deps.sendStop,
    onVoiceAvailable: (available) => {
      model.ttsUp = available;
      tellHealth(model);
    },
    timers: deps.timers,
  });
  return { recording, speech };
}

function createModel(): VoiceModel {
  return {
    state: null,
    admitted: new Map(),
    nextOrder: 1,
    current: null,
    sttUp: true,
    sttOrder: 0,
    ttsUp: true,
    told: true,
    releasedAt: null,
  };
}

// Joins recording and speech to main's state; main's state is built with say and silence first, then given here by start.
export function createVoice(deps: VoiceDeps): Voice {
  const model = createModel();
  const flows = createFlows(model, deps);
  const { recording, speech } = flows;
  const withState = (name: string, call: (state: VoiceState) => void) => {
    const state = model.state;
    if (state === null) return deps.log(`${name} before start: ignored`);
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
    clipArrived: (clip) => withState("clip", () => recording.clipArrived(clip)),
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
    rendererReset: () => {
      recording.rendererReset();
      speech.rendererReset();
      model.admitted.clear();
      model.current = null;
    },
  };
}
