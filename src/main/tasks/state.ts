import type { DisplayState, TaskId, UtteranceId } from "../../shared/cards";
import type { EngineCommand, EngineEvent } from "../../shared/engine";
import type {
  AnswerQuestion,
  OpenSource,
  SetCardFolded,
} from "../../shared/ipc";
import { ask, bindAnswer } from "./ask";
import { buildDisplay, waitingQuestion } from "./display";
import { receiveFront, retryTask } from "./front";
import { setVoiceAvailable, showNotice } from "./notices";
import type { Notice } from "./notices";
import type {
  Change,
  Input,
  Model,
  Output,
  SaidKind as RecordSaidKind,
  SaidLine as RecordSaidLine,
} from "./record";
import { createModel, dropped, isEnded, silence } from "./record";
import { showNextQuestion } from "./questions";
import type { TalkRequest, TalkerReply, WaitingQuestion } from "./talk";
import {
  cancelTask,
  receiveRunEvent,
  receiveUnaskedCancel,
  receiveWhileCancelling,
  startNext,
} from "./run";

// Defined beside the model, which records the lines; named here as part of the public interface.
export type SaidKind = RecordSaidKind;
export type SaidLine = RecordSaidLine;

// Injected so the state runs and is tested without Electron, real timers or random ids.
export type Timers = { setTimer: (ms: number, fire: () => void) => () => void };

export type MainStateDeps = {
  send: (command: EngineCommand) => void;
  publish: (state: DisplayState) => void;
  say: (line: SaidLine) => void;
  silence: (taskId: TaskId) => void;
  talk: (request: TalkRequest) => void;
  cancelAttempt: (attemptId: string) => void;
  openUrl: (url: string) => Promise<void>;
  log: (message: string) => void;
  timers: Timers;
  newTaskId: () => TaskId;
};

export type MainState = {
  ask: (
    words: string,
    utteranceId: UtteranceId | null,
    waiting: WaitingQuestion | null,
  ) => void;
  waitingQuestion: () => WaitingQuestion | null;
  answerQuestion: (payload: AnswerQuestion) => void;
  cancelTask: (taskId: TaskId) => void;
  retryTask: (taskId: TaskId) => void;
  closeCard: (taskId: TaskId) => void;
  setCardFolded: (payload: SetCardFolded) => void;
  openSource: (payload: OpenSource) => void;
  setMuted: (muted: boolean) => void;
  setVoiceAvailable: (available: boolean) => void;
  showNotice: (notice: Notice) => void;
  talkerReplied: (
    taskId: TaskId,
    attemptId: string,
    reply: TalkerReply,
  ) => void;
  receive: (event: EngineEvent) => void;
  displayState: () => DisplayState;
};

export function createMainState(deps: MainStateDeps): MainState {
  const model = createModel();
  const update = createUpdatePath(model, deps);
  return {
    ask: (words, utteranceId, waiting) =>
      update((c) => ask(c, deps.newTaskId, { words, utteranceId, waiting })),
    waitingQuestion: () => waitingQuestion(model),
    answerQuestion: (payload) => update((c) => bindAnswer(c, payload)),
    cancelTask: (taskId) => update((c) => cancelTask(c, taskId)),
    retryTask: (taskId) => update((c) => retryTask(c, taskId)),
    closeCard: (taskId) => update((c) => closeCard(c, taskId)),
    setCardFolded: (payload) => update((c) => setCardFolded(c, payload)),
    openSource: (payload) => update((c) => openSource(c, deps, payload)),
    setMuted: (muted) => update((c) => setMuted(c, muted)),
    setVoiceAvailable: (available) =>
      update((c) => setVoiceAvailable(c, available)),
    showNotice: (notice) => update((c) => showNotice(c, notice)),
    talkerReplied: (taskId, attemptId, reply) =>
      update((c) => receiveFront(c, taskId, attemptId, reply)),
    receive: (event) => update((c) => receiveEvent(c, event)),
    displayState: () => buildDisplay(model),
  };
}

// A closed window or a failed line must not stop the other outputs or the inbox.
function guarded(deps: MainStateDeps, what: string, call: () => void): void {
  try {
    call();
  } catch (error: unknown) {
    deps.log(`${what} failed: ${String(error)}`);
  }
}

function flushOutput(
  deps: MainStateDeps,
  update: (input: Input) => void,
  output: Output,
): void {
  const guard = (what: string, call: () => void) => guarded(deps, what, call);
  // A failed send leaves a command the model counts as held, so it surfaces to main's restart path.
  if (output.kind === "send") {
    deps.send(output.command);
  } else if (output.kind === "say") {
    guard("say", () => deps.say(output.line));
  } else if (output.kind === "silence") {
    guard("silence", () => deps.silence(output.taskId));
  } else if (output.kind === "talk") {
    guard("talk", () => deps.talk(output.request));
  } else if (output.kind === "cancelAttempt") {
    guard("cancelAttempt", () => deps.cancelAttempt(output.attemptId));
  } else {
    guard("timer", () =>
      deps.timers.setTimer(output.ms, () => update(output.fire)),
    );
  }
}

// One path for every change; an input that arrives while it runs (the engine may reply inside send) waits its turn.
function createUpdatePath(
  model: Model,
  deps: MainStateDeps,
): (input: Input) => void {
  const inbox: Input[] = [];
  let running = false;
  const apply = (input: Input): void => {
    const change: Change = { model, outputs: [], log: deps.log };
    if (!input(change)) return;
    startNext(change);
    showNextQuestion(change);
    guarded(deps, "publish", () => deps.publish(buildDisplay(model)));
    change.outputs.forEach((output) => flushOutput(deps, update, output));
  };
  const update = (input: Input): void => {
    inbox.push(input);
    if (running) return;
    running = true;
    try {
      for (let next = inbox.shift(); next; next = inbox.shift()) apply(next);
    } finally {
      running = false;
    }
  };
  return update;
}

function receiveEvent(change: Change, event: EngineEvent): boolean {
  const record = change.model.records.get(event.taskId);
  if (record === undefined) {
    return dropped(change, `${event.type} for unknown ${event.taskId}`);
  }
  if (record.card.state === "cancelling") {
    return receiveWhileCancelling(change, record, event);
  }
  switch (event.type) {
    case "cancelled":
      return receiveUnaskedCancel(change, record, event.findings);
    case "intake":
    case "failure":
      return dropped(change, `${event.type} for ${event.taskId}`);
    default:
      return receiveRunEvent(change, record, event);
  }
}

function closeCard(change: Change, taskId: TaskId): boolean {
  const record = change.model.records.get(taskId);
  if (record === undefined || !record.shown || !isEnded(record.card.state)) {
    return dropped(change, `close ${taskId}`);
  }
  record.shown = false;
  silence(change, taskId);
  return true;
}

function setCardFolded(change: Change, payload: SetCardFolded): boolean {
  const record = change.model.records.get(payload.taskId);
  const state = record?.card.state;
  if (
    record === undefined ||
    !record.shown ||
    state === undefined ||
    !isEnded(state) ||
    state === "cancelled" ||
    record.card.folded === payload.folded
  ) {
    return dropped(change, `fold ${payload.taskId}`);
  }
  record.card.folded = payload.folded;
  return true;
}

// Opening changes no state, so it always returns false and publishes nothing.
function openSource(
  change: Change,
  deps: MainStateDeps,
  { taskId, url }: OpenSource,
): false {
  const answer = change.model.records.get(taskId)?.card.answer ?? null;
  const listed = answer?.sources.some((source) => source.url === url) ?? false;
  if (!listed || !isWebUrl(url)) {
    return dropped(change, `open ${url} for ${taskId}`);
  }
  deps.openUrl(url).catch((error: unknown) => {
    deps.log(`opening ${url} failed: ${String(error)}`);
  });
  return false;
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function setMuted(change: Change, muted: boolean): boolean {
  if (change.model.muted === muted) return dropped(change, "same muted");
  change.model.muted = muted;
  return true;
}
