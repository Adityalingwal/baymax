import type { Aura, AuraListener } from "../providers/aura";
import type { Synthesis, Transcription } from "../providers/deepgram";
import type { Flux, FluxListener } from "../providers/flux";
import type { TaskId, UtteranceId } from "../shared/cards";
import type {
  HoldState,
  LineId,
  MicAudio,
  PlaybackFinished,
  RecordingCommand,
  SpeakingLine,
  SpeechChunk,
  SpeechEnd,
  SpeechLine,
  StopPlayback,
  VoicePhase,
} from "../shared/ipc";
import type { HoldOutcome } from "./hold";
import { createRecording } from "./recording";
import type { Heard, NotCaughtCause } from "./recording";
import { createSpeech } from "./speech";
import type { LineFeed, Spoken } from "./speech";
import { createGapWatch, createTalkerTiming } from "./voice-timing";
import type { WaitingQuestion } from "./tasks/talk";
import type { VoiceDownNotice } from "./tasks/record";
import type { MainState, SaidLine, Timers } from "./tasks/state";

export type VoiceState = Pick<
  MainState,
  "ask" | "waitingQuestion" | "setMuted" | "setVoiceAvailable" | "showNotice"
>;

export type VoiceDeps = {
  sendRecording: (command: RecordingCommand) => void;
  sendSpeech: (line: SpeechLine) => void;
  sendChunk: (chunk: SpeechChunk) => void;
  sendEnd: (end: SpeechEnd) => void;
  sendStop: (payload: StopPlayback) => void;
  sendVoicePhase: (phase: VoicePhase) => void;
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
  islandClosed(lineId: LineId): void;
  setMuted(muted: boolean): void;
  say(line: SaidLine): void;
  talk(spoken: Spoken): LineFeed;
  submitted(key: string): void; // a typed question: its talker timing starts as at a key release
  silence(taskId: TaskId): void;
  cutFailure(taskId: TaskId): void;
  rendererReset(): void;
  stop(): void;
};

// The waiting question at key-down, the hold's place in time and its release, kept until its words are delivered.
type Admitted = {
  waiting: WaitingQuestion | null;
  order: number;
  releasedAt: number | null;
};

type VoiceModel = {
  state: VoiceState | null;
  admitted: Map<UtteranceId, Admitted>;
  nextOrder: number;
  current: UtteranceId | null;
  sttUp: boolean;
  sttOrder: number;
  ttsUp: boolean;
  told: boolean;
  downNotice: VoiceDownNotice;
  releasedAt: number | null;
  held: boolean;
  stopped: boolean;
};

// An accepted hold whose turn has not spoken yet; taskId is known once its front call's line is queued.
type Pending = { key: UtteranceId; taskId: TaskId | null };

type Tracker = {
  held: boolean;
  pending: Pending | null;
  speaking: SpeakingLine | null;
};

type PhaseTracker = {
  holdStarted(): void;
  holdEnded(accepted: UtteranceId | null): void;
  turnEnded(utteranceId: UtteranceId): void; // not caught or dropped
  asked(utteranceId: UtteranceId): void; // its words went to main's state
  talkQueued(spoken: Spoken): void;
  audioStarted(spoken: Spoken, lineId: LineId): void;
  lineGone(spoken: Spoken, lineId: LineId | null): void;
  reset(): void;
};

type HeardDeps = { now: () => number; log: (message: string) => void };

type Flows = {
  recording: ReturnType<typeof createRecording>;
  speech: ReturnType<typeof createSpeech>;
  timing: ReturnType<typeof createTalkerTiming>;
  phases: ReturnType<typeof createPhaseTracker>;
};

const admittedLimit = 16;

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
    downNotice: "voiceUnavailable",
    releasedAt: null,
    held: false,
    stopped: false,
  };
}

function admit(model: VoiceModel, utteranceId: UtteranceId): void {
  const waiting = model.state?.waitingQuestion() ?? null;
  const order = model.nextOrder;
  model.admitted.set(utteranceId, { waiting, order, releasedAt: null });
  model.nextOrder += 1;
  if (model.admitted.size <= admittedLimit) return;
  const oldest = model.admitted.keys().next();
  if (oldest.done !== true) model.admitted.delete(oldest.value);
}

function tellHealth(model: VoiceModel): void {
  const up = model.sttUp && model.ttsUp;
  const state = model.state;
  if (state === null || up === model.told) return;
  model.told = up;
  state.setVoiceAvailable(up, model.downNotice);
}

// An older utterance's result arriving late never overrides a newer one's.
function setStt(
  model: VoiceModel,
  log: (message: string) => void,
  up: boolean,
  order: number,
): void {
  if (order <= model.sttOrder) {
    log("an older transcript result left STT health as it was");
    return;
  }
  model.sttOrder = order;
  model.sttUp = up;
  tellHealth(model);
}
// Listening wins, then the line playing, then the pending turn.
function phaseOf(tracker: Tracker): VoicePhase {
  if (tracker.held) return { phase: "listening" };
  if (tracker.speaking !== null) {
    return { phase: "speaking", line: tracker.speaking };
  }
  return tracker.pending === null ? { phase: "idle" } : { phase: "thinking" };
}

// A line of the pending turn: its front call's line, or any later line of the same task (a failure line).
function ofPending(tracker: Tracker, spoken: Spoken): boolean {
  const { pending } = tracker;
  if (pending === null) return false;
  if (spoken.key !== null && spoken.key === pending.key) return true;
  return pending.taskId !== null && spoken.taskId === pending.taskId;
}

function endTurn(tracker: Tracker, key: UtteranceId): void {
  if (tracker.pending?.key === key) tracker.pending = null;
}

// A new hold silences every line, so an earlier turn's line will not speak.
function holdStarted(tracker: Tracker): void {
  tracker.held = true;
  tracker.pending = null;
}

function holdEnded(tracker: Tracker, accepted: UtteranceId | null): void {
  tracker.held = false;
  if (accepted !== null) tracker.pending = { key: accepted, taskId: null };
}

// Main's state starts a front call at once, so a turn still without a task had its words dropped.
function asked(tracker: Tracker, key: UtteranceId): void {
  if (tracker.pending?.taskId === null) endTurn(tracker, key);
}

function talkQueued(tracker: Tracker, spoken: Spoken): void {
  const { pending } = tracker;
  if (pending !== null && spoken.key === pending.key) {
    pending.taskId = spoken.taskId;
  }
}

function audioStarted(tracker: Tracker, spoken: Spoken, lineId: LineId) {
  if (ofPending(tracker, spoken)) tracker.pending = null;
  tracker.speaking = { lineId, taskId: spoken.taskId, kind: spoken.kind };
}

// A line of the turn that never spoke ends the turn; only the speaking line's own end clears Speaking.
function lineGone(tracker: Tracker, spoken: Spoken, lineId: LineId | null) {
  if (ofPending(tracker, spoken)) tracker.pending = null;
  if (lineId !== null && tracker.speaking?.lineId === lineId) {
    tracker.speaking = null;
  }
}

function createPhaseTracker(send: (phase: VoicePhase) => void): PhaseTracker {
  const tracker: Tracker = { held: false, pending: null, speaking: null };
  let sent = JSON.stringify(phaseOf(tracker));
  const after =
    <A extends unknown[]>(change: (t: Tracker, ...a: A) => void) =>
    (...args: A): void => {
      change(tracker, ...args);
      const phase = phaseOf(tracker);
      const text = JSON.stringify(phase);
      if (text === sent) return;
      sent = text;
      send(phase);
    };
  return {
    holdStarted: after(holdStarted),
    holdEnded: after(holdEnded),
    turnEnded: after(endTurn),
    asked: after(asked),
    talkQueued: after(talkQueued),
    audioStarted: after(audioStarted),
    lineGone: after(lineGone),
    reset: after((t) => {
      t.pending = null;
    }),
  };
}

function notCaught(
  model: VoiceModel,
  deps: HeardDeps,
  state: VoiceState,
  cause: NotCaughtCause,
  order: number,
): void {
  switch (cause) {
    case "silent":
      return setStt(model, deps.log, true, order);
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

// A held utterance's result: its words go to main's state; a miss shows its line and ends the pending turn.
function receiveHeard(
  model: VoiceModel,
  deps: HeardDeps,
  phases: PhaseTracker,
  heard: Heard,
): void {
  const entry = model.admitted.get(heard.utteranceId);
  const state = model.state;
  if (entry === undefined || state === null) {
    deps.log(`${heard.kind} dropped: utterance not admitted`);
    phases.turnEnded(heard.utteranceId);
    return;
  }
  model.admitted.delete(heard.utteranceId);
  if (entry.releasedAt !== null) {
    const ms = Math.round(deps.now() - entry.releasedAt);
    deps.log(`final transcript ${ms} ms after release`);
  }
  if (heard.kind === "notCaught") {
    phases.turnEnded(heard.utteranceId);
    return notCaught(model, deps, state, heard.cause, entry.order);
  }
  setStt(model, deps.log, true, entry.order);
  state.ask(heard.words, heard.utteranceId, entry.waiting);
  phases.asked(heard.utteranceId);
}

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

function holdChanged(
  model: VoiceModel,
  deps: VoiceDeps,
  flows: Flows,
  change: { holdState: HoldState; outcome: HoldOutcome | null },
): void {
  model.held = change.holdState === "listening";
  if (model.held) {
    flows.phases.holdStarted();
    model.releasedAt = null;
    // Recording discards a hold still open when a new one starts.
    if (model.current !== null) model.admitted.delete(model.current);
    flows.speech.holdStarted();
    flows.recording.holdStarted();
    return;
  }
  const outcome = change.outcome;
  if (outcome === null) return flows.phases.holdEnded(null);
  const ending = model.current;
  flows.phases.holdEnded(outcome === "accept" ? ending : null);
  flows.recording.holdEnded(outcome);
  if (outcome === "discard" && ending !== null) model.admitted.delete(ending);
  if (outcome === "accept") {
    model.releasedAt = deps.now();
    const entry = ending === null ? undefined : model.admitted.get(ending);
    if (entry !== undefined) entry.releasedAt = model.releasedAt;
    if (ending !== null) flows.timing.released(ending, model.releasedAt);
  }
  flows.speech.holdEnded();
}

function createFlows(model: VoiceModel, deps: VoiceDeps): Flows {
  const timing = createTalkerTiming({ now: deps.now, log: deps.log });
  const phases = createPhaseTracker((phase) =>
    contained(deps, "sendVoicePhase", () => deps.sendVoicePhase(phase)),
  );
  const gaps = createGapWatch(deps.now, deps.log);
  const recording = createRecording({
    sendRecording: (command) => sendRecording(model, deps, command),
    startFlux: deps.startFlux,
    transcribe: deps.transcribe,
    timers: deps.timers,
    log: deps.log,
    onHeard: (heard) =>
      forwarded(deps, () => receiveHeard(model, deps, phases, heard)),
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
      gaps(chunk);
      deps.sendChunk(chunk);
    },
    sendEnd: deps.sendEnd,
    sendStop: deps.sendStop,
    onVoiceAvailable: (available) => {
      model.ttsUp = available;
      forwarded(deps, () => tellHealth(model));
    },
    onAudioStarted: (line, lineId) => {
      timing.audioStarted(line);
      phases.audioStarted(line, lineId);
    },
    onLineGone: (line, lineId) => phases.lineGone(line, lineId),
    timers: deps.timers,
  });
  return { recording, speech, timing, phases };
}

function forgetRenderer(model: VoiceModel, flows: Flows): void {
  flows.recording.rendererReset();
  flows.speech.rendererReset();
  flows.phases.reset();
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
  flows.phases.holdEnded(null);
  flows.phases.reset();
  flows.speech.holdEnded();
  flows.speech.releaseResults();
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
      if (!deps.deepgramKeyPresent) model.downNotice = "keyMissing";
      tellHealth(model);
    },
    holdChanged: (holdState, outcome) =>
      withState("hold change", () =>
        holdChanged(model, deps, flows, { holdState, outcome }),
      ),
    micAudio: (audio) =>
      withState("mic audio", () => recording.micAudio(audio)),
    playbackFinished: (payload) => speech.playbackFinished(payload),
    islandClosed: (lineId) => speech.islandClosed(lineId),
    setMuted: (muted) =>
      withState("mute", (state) => {
        try {
          state.setMuted(muted);
        } finally {
          speech.setMuted(muted);
        }
      }),
    say: (line) => contained(deps, "say", () => speech.speak(line)),
    talk: (spoken) => {
      flows.phases.talkQueued(spoken);
      return flows.timing.timed(spoken.key, speech.speakFed(spoken));
    },
    submitted: (key) => flows.timing.released(key, deps.now()),
    silence: (taskId) =>
      contained(deps, "silence", () => speech.cancelTask(taskId)),
    cutFailure: (taskId) =>
      contained(deps, "cutFailure", () => speech.cutFailure(taskId)),
    rendererReset: () => forgetRenderer(model, flows),
    stop: () => stopVoice(model, flows),
  };
}
