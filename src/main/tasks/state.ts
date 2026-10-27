import type { DisplayState, TaskId, UtteranceId } from "../../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  IntakeOutcome,
  WaitingQuestion,
} from "../../shared/engine";
import type {
  AnswerQuestion,
  OpenSource,
  SetCardFolded,
} from "../../shared/ipc";
import { buildDisplay, waitingQuestion } from "./display";
import {
  applyIntakeOutcome,
  ask,
  bindAnswer,
  failIntake,
  retryTask,
} from "./intake";
import { setVoiceAvailable, showNotice } from "./notices";
import type { Notice } from "./notices";
import type {
  Change,
  Input,
  Model,
  Output,
  SaidKind as RecordSaidKind,
  SaidLine as RecordSaidLine,
  TaskRecord,
} from "./record";
import {
  closeIntakeStep,
  createModel,
  dropped,
  holdsIntake,
  isEnded,
  showNextQuestion,
  silence,
} from "./record";
import {
  admit,
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
    receive: (event) => update((c) => receiveEvent(c, event)),
    displayState: () => buildDisplay(model),
  };
}

// One path for every change; an input that arrives while it runs (the engine may reply inside send) waits its turn.
function createUpdatePath(
  model: Model,
  deps: MainStateDeps,
): (input: Input) => void {
  const inbox: Input[] = [];
  let running = false;
  // A closed window or a failed line must not stop the other outputs or the inbox.
  const guarded = (what: string, call: () => void): void => {
    try {
      call();
    } catch (error: unknown) {
      deps.log(`${what} failed: ${String(error)}`);
    }
  };
  const flush = (output: Output): void => {
    // A failed send leaves a command the model counts as held, so it surfaces to main's restart path.
    if (output.kind === "send") {
      deps.send(output.command);
    } else if (output.kind === "say") {
      guarded("say", () => deps.say(output.line));
    } else if (output.kind === "silence") {
      guarded("silence", () => deps.silence(output.taskId));
    } else {
      guarded("timer", () =>
        deps.timers.setTimer(output.ms, () => update(output.fire)),
      );
    }
  };
  const apply = (input: Input): void => {
    const change: Change = { model, outputs: [], log: deps.log };
    if (!input(change)) return;
    startNext(change);
    showNextQuestion(change);
    guarded("publish", () => deps.publish(buildDisplay(model)));
    change.outputs.forEach(flush);
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
      return receiveIntake(change, record, event.outcome);
    case "failure":
      return failIntake(change, record, event.kind);
    default:
      return receiveRunEvent(change, record, event);
  }
}

function receiveIntake(
  change: Change,
  record: TaskRecord,
  outcome: IntakeOutcome,
): boolean {
  if (!holdsIntake(record)) {
    return dropped(change, `intake for ${record.card.taskId}`);
  }
  if (outcome.route === "answer" && record.sent?.type === "clarifyingAnswer") {
    change.log(
      `answer route in reply to a clarifying answer for ${record.card.taskId}`,
    );
    return failIntake(change, record, "error");
  }
  closeIntakeStep(record);
  if (outcome.route === "newTask" || outcome.route === "followUp") {
    return admit(change, record, outcome);
  }
  return applyIntakeOutcome(change, record, outcome);
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
