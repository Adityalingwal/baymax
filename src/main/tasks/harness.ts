import type {
  ClarifyingQuestion,
  DisplayState,
  Findings,
  TaskCard,
  TaskId,
} from "../../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  IntakeOutcome,
  WorkerBrief,
} from "../../shared/engine";
import type { MainState, MainStateDeps, SaidLine, Timers } from "./state";
import { createMainState } from "./state";

type PendingTimer = { at: number; order: number; fire: () => void };

// A manual clock: advancing fires every due timer in time order, then stops at the target.
function createClock() {
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
  logs: string[];
  opened: string[];
  timeline: string[];
  advance: (ms: number) => void;
  last: () => DisplayState;
  card: (taskId: TaskId) => TaskCard | undefined;
  lastTaskId: () => TaskId;
  replyWith: (reply: Reply) => void;
  failOpen: (message: string) => void;
};

type Seen = Pick<
  Harness,
  "published" | "sent" | "said" | "logs" | "opened" | "timeline"
>;
type Controls = { reply: Reply; openFailure: string | null; ids: number };

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
      seen.published.push(display);
      seen.timeline.push("publish");
    },
    say: (line) => {
      seen.said.push(line);
      seen.timeline.push(`say ${line.kind}`);
    },
    openUrl: (url) => {
      seen.opened.push(url);
      const failure = controls.openFailure;
      return failure === null
        ? Promise.resolve()
        : Promise.reject(new Error(failure));
    },
    log: (message) => seen.logs.push(message),
    timers: { setTimer },
    newTaskId: () => {
      controls.ids += 1;
      return `t${controls.ids}`;
    },
  };
}

export function createHarness(): Harness {
  const clock = createClock();
  const seen: Seen = {
    published: [],
    sent: [],
    said: [],
    logs: [],
    opened: [],
    timeline: [],
  };
  const controls: Controls = { reply: () => null, openFailure: null, ids: 0 };
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
  };
}

export function brief(goal: string): WorkerBrief {
  return {
    goal,
    resultShape: "a short answer",
    sources: "the web",
    limits: "normal",
    userWords: goal,
  };
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

export function newTask(sayBack: string): IntakeOutcome {
  return {
    route: "newTask",
    sayBack,
    startLine: `Looking into ${sayBack}.`,
    brief: brief(sayBack),
  };
}

export function intake(taskId: TaskId, outcome: IntakeOutcome): EngineEvent {
  return { type: "intake", taskId, outcome };
}

// Asks and admits a new task; returns its id.
export function askNew(h: Harness, sayBack: string): TaskId {
  h.state.ask(`tell me ${sayBack}`, null, null);
  const taskId = h.lastTaskId();
  h.state.receive(intake(taskId, newTask(sayBack)));
  return taskId;
}

export function followUp(parentTaskId: TaskId, sayBack: string): IntakeOutcome {
  return {
    route: "followUp",
    parentTaskId,
    sayBack,
    startLine: `Looking into ${sayBack}.`,
    brief: brief(sayBack),
  };
}

// Asks and admits a follow-up of parentTaskId; returns its id.
export function askFollowUp(
  h: Harness,
  parentTaskId: TaskId,
  sayBack: string,
): TaskId {
  h.state.ask(`and ${sayBack}`, null, null);
  const taskId = h.lastTaskId();
  h.state.receive(intake(taskId, followUp(parentTaskId, sayBack)));
  return taskId;
}

export function question(questionId: string): ClarifyingQuestion {
  return {
    questionId,
    text: `Question ${questionId}?`,
    choices: ["First", "Second", "Third"],
  };
}

// Asks words the intake answers with a clarifying question; returns the task id.
export function askClarify(h: Harness, questionId: string): TaskId {
  h.state.ask(`about ${questionId}`, null, null);
  const taskId = h.lastTaskId();
  h.state.receive(
    intake(taskId, {
      route: "clarify",
      sayBack: `about ${questionId}`,
      question: question(questionId),
    }),
  );
  return taskId;
}

export function finish(h: Harness, taskId: TaskId, text = "Done."): void {
  h.state.receive({
    type: "result",
    taskId,
    spokenLine: `${text} spoken`,
    findings: findings(text),
  });
}

// What the fakes saw so far, to show that a dropped input changed nothing.
export function counts(h: Harness): [number, number, number] {
  return [h.published.length, h.sent.length, h.said.length];
}
