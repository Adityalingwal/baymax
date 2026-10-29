import type {
  DisplayState,
  Findings,
  TaskCard,
  TaskId,
} from "../../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  FailureKind,
  TaskAsk,
} from "../../shared/engine";
import type { AnswerQuestion } from "../../shared/ipc";
import type { TalkRequest, WaitingQuestion } from "./talk";
import type { MainState, MainStateDeps, SaidLine, Timers } from "./state";
import { createMainState } from "./state";

type PendingTimer = { at: number; order: number; fire: () => void };

// A manual clock: advancing fires every due timer in time order, then stops at the target.
export function createClock() {
  let now = 0;
  let order = 0;
  let pending: PendingTimer[] = [];
  const setTimer = (ms: number, fire: () => void): (() => void) => {
    order += 1;
    const timer = { at: now + ms, order, fire };
    pending.push(timer);
    return () => {
      pending = pending.filter((other) => other !== timer);
    };
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = pending
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order);
      if (due.length === 0) break;
      pending = pending.filter((timer) => timer !== due[0]);
      now = due[0].at;
      due[0].fire();
    }
    now = target;
  };
  return { setTimer, advance };
}

type Reply = (command: EngineCommand) => EngineEvent | null;

export type Harness = {
  state: MainState;
  published: DisplayState[];
  sent: EngineCommand[];
  said: SaidLine[];
  talked: TalkRequest[];
  cancelled: string[]; // front call attempts aborted
  silenced: TaskId[];
  logs: string[];
  opened: string[];
  timeline: string[];
  advance: (ms: number) => void;
  last: () => DisplayState;
  card: (taskId: TaskId) => TaskCard | undefined;
  lastTaskId: () => TaskId;
  replyWith: (reply: Reply) => void;
  failOpen: (message: string) => void;
  failPublish: (message: string) => void;
  reply: (taskId: TaskId, decision: unknown, line?: string) => void;
  replyFailed: (taskId: TaskId, failure: FailureKind) => void;
};

type Seen = Pick<
  Harness,
  | "published"
  | "sent"
  | "said"
  | "talked"
  | "cancelled"
  | "silenced"
  | "logs"
  | "opened"
  | "timeline"
>;
type Controls = {
  reply: Reply;
  openFailure: string | null;
  publishFailure: string | null;
  ids: number;
};

function opening(seen: Seen, controls: Controls, url: string): Promise<void> {
  seen.opened.push(url);
  const failure = controls.openFailure;
  return failure === null
    ? Promise.resolve()
    : Promise.reject(new Error(failure));
}

function fakeDeps(
  seen: Seen,
  controls: Controls,
  setTimer: Timers["setTimer"],
  receive: (event: EngineEvent) => void,
): MainStateDeps {
  return {
    send: (command) => {
      seen.sent.push(command);
      seen.timeline.push(`send ${command.type} ${command.taskId}`);
      const event = controls.reply(command);
      if (event !== null) receive(event);
    },
    publish: (display) => {
      if (controls.publishFailure !== null) {
        throw new Error(controls.publishFailure);
      }
      seen.published.push(display);
      seen.timeline.push("publish");
    },
    say: (line) => {
      seen.said.push(line);
      seen.timeline.push(`say ${line.kind}`);
    },
    silence: (taskId) => {
      seen.silenced.push(taskId);
      seen.timeline.push(`silence ${taskId}`);
    },
    talk: (request) => {
      seen.talked.push(request);
      seen.timeline.push(`talk ${request.kind} ${request.taskId}`);
    },
    cancelAttempt: (attemptId) => {
      seen.cancelled.push(attemptId);
      seen.timeline.push(`cancel ${attemptId}`);
    },
    openUrl: (url) => opening(seen, controls, url),
    log: (message) => seen.logs.push(message),
    timers: { setTimer },
    newTaskId: () => {
      controls.ids += 1;
      return `t${controls.ids}`;
    },
  };
}

// A test answers the latest front call asked for a task.
function repliers(
  state: MainState,
  talked: TalkRequest[],
): Pick<Harness, "reply" | "replyFailed"> {
  const attemptOf = (taskId: TaskId): string => {
    const latest = talked.filter((request) => request.taskId === taskId).at(-1);
    if (latest === undefined) throw new Error(`no front call for ${taskId}`);
    return latest.attemptId;
  };
  return {
    reply: (taskId, decision, line = "Okay.") =>
      state.talkerReplied(taskId, attemptOf(taskId), {
        kind: "said",
        text: line,
        decision,
      }),
    replyFailed: (taskId, failure) =>
      state.talkerReplied(taskId, attemptOf(taskId), {
        kind: "failed",
        failure,
      }),
  };
}

export function createHarness(): Harness {
  const clock = createClock();
  const seen: Seen = {
    published: [],
    sent: [],
    said: [],
    talked: [],
    cancelled: [],
    silenced: [],
    logs: [],
    opened: [],
    timeline: [],
  };
  const controls: Controls = {
    reply: () => null,
    openFailure: null,
    publishFailure: null,
    ids: 0,
  };
  const state: MainState = createMainState(
    fakeDeps(seen, controls, clock.setTimer, (event) => state.receive(event)),
  );
  const last = (): DisplayState =>
    seen.published.at(-1) ?? state.displayState();
  return {
    ...seen,
    state,
    advance: clock.advance,
    last,
    card: (taskId) => last().tasks.find((card) => card.taskId === taskId),
    lastTaskId: () => `t${controls.ids}`,
    replyWith: (reply) => {
      controls.reply = reply;
    },
    failOpen: (message) => {
      controls.openFailure = message;
    },
    failPublish: (message) => {
      controls.publishFailure = message;
    },
    ...repliers(state, seen.talked),
  };
}

export function ask(goal: string, userWords = goal): TaskAsk {
  return { goal, userWords };
}

export function findings(text: string, urls: string[] = []): Findings {
  return {
    cardText: text,
    sources: urls.map((url, index) => ({
      id: `s${index + 1}`,
      url,
      title: url,
    })),
    openPoints: [],
  };
}

// The decide tool's input: every field present, unused ones empty.
export function decision(fields: Record<string, unknown>) {
  return {
    route: "chat",
    topic: null,
    parentTaskId: null,
    answerTo: null,
    choices: [],
    goal: null,
    ...fields,
  };
}

export const chat = () => decision({ route: "chat" });

export const outsideResearch = () => decision({ route: "outsideResearch" });

export const newTask = (topic: string, answerTo: string | null = null) =>
  decision({ route: "newTask", topic, goal: topic, answerTo });

export const followUp = (parentTaskId: TaskId, topic: string) =>
  decision({
    route: "followUp",
    topic,
    parentTaskId,
    goal: topic,
  });

export const clarify = (choices = ["First", "Second", "Third"]) =>
  decision({ route: "clarify", topic: "about it", choices });

// Asks the words and answers the front call with a new task; returns the task's id.
export function askNew(h: Harness, topic: string): TaskId {
  h.state.ask(`tell me ${topic}`, null, null);
  const taskId = h.lastTaskId();
  h.reply(taskId, newTask(topic), `Checking ${topic}.`);
  return taskId;
}

export function askFollowUp(
  h: Harness,
  parentTaskId: TaskId,
  topic: string,
): TaskId {
  h.state.ask(`and ${topic}`, null, null);
  const taskId = h.lastTaskId();
  h.reply(taskId, followUp(parentTaskId, topic), `Checking ${topic}.`);
  return taskId;
}

// The id the front call's clarifying question gets: one question per task.
export const questionIdOf = (taskId: TaskId) => `${taskId}:question`;

export function askClarify(
  h: Harness,
  choices?: string[],
  words = "about it",
): TaskId {
  h.state.ask(words, null, null);
  const taskId = h.lastTaskId();
  h.reply(taskId, clarify(choices), `Which one for ${taskId}?`);
  return taskId;
}

// A click on a choice of the task's question card.
export function click(
  taskId: TaskId,
  index = 0,
  questionId = questionIdOf(taskId),
): AnswerQuestion {
  return { taskId, questionId, reply: { kind: "choice", index } };
}

export function waitingOf(h: Harness): WaitingQuestion {
  const waiting = h.state.waitingQuestion();
  if (waiting === null) throw new Error("no question is waiting");
  return waiting;
}

export function finish(h: Harness, taskId: TaskId, text = "Done."): void {
  h.state.receive({
    type: "result",
    taskId,
    spokenLine: `${text} spoken`,
    findings: findings(text),
  });
}

export function counts(h: Harness): [number, number, number] {
  return [h.published.length, h.sent.length, h.said.length];
}
