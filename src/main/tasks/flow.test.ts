import { afterEach, describe, expect, it } from "vitest";
import type { TextOutcome, TextStream } from "../../providers/anthropic";
import type { DisplayState, TaskCard } from "../../shared/cards";
import type { EngineCommand, EnginePort } from "../../shared/engine";
import { createTalker } from "../talker";
import { finished } from "../talker.harness";
import type { ModelRequest, Outcome } from "./flow.harness";
import {
  closePorts,
  startFakeEngine,
  until,
  unreachable,
} from "./flow.harness";
import {
  chat,
  clarify,
  decision,
  followUp,
  newTask,
  outsideResearch,
} from "./harness";
import type { MainState, SaidLine } from "./state";
import { createMainState } from "./state";

afterEach(closePorts);

// What the front call says and decides for one utterance; the model stream is faked, the talker is real.
type Front = { line: string; decision: unknown };

const front = (line: string, input: unknown): Front => ({
  line,
  decision: input,
});

function fakeFront(script: Front[]): { stream: TextStream; asked: string[] } {
  const asked: string[] = [];
  const stream: TextStream = (request, _options, onText, onToolStart) => {
    const content = request.messages.at(-1)?.content;
    asked.push(typeof content === "string" ? content : "");
    const next = script.shift();
    if (next === undefined) throw new Error("no fake front call left");
    onText(next.line);
    onToolStart?.();
    const outcome: TextOutcome = finished(next.line, [
      { name: "decide", input: next.decision },
    ]);
    return Promise.resolve(outcome);
  };
  return { stream, asked };
}

// Main's state with recording deps, the real talker on a fake model stream, and the real engine behind a recording port.
function mainStateOn(port: EnginePort, script: Front[]) {
  const sent: EngineCommand[] = [];
  const said: SaidLine[] = [];
  const published: DisplayState[] = [];
  const logs: string[] = [];
  const fake = fakeFront(script);
  let ids = 0;
  const talker = createTalker({
    stream: fake.stream,
    talk: () => ({
      push: () => undefined,
      end: () => undefined,
      cut: () => undefined,
    }),
    onReply: (taskId, attemptId, reply) =>
      state.talkerReplied(taskId, attemptId, reply),
    timers: { setTimer: () => () => undefined },
    log: (message) => logs.push(message),
  });
  const state: MainState = createMainState({
    send: (command) => {
      sent.push(structuredClone(command));
      port.send(command);
    },
    publish: (display) => published.push(display),
    say: (line) => said.push(line),
    silence: () => undefined,
    talk: talker.talk,
    cancelAttempt: talker.cancel,
    openUrl: () => Promise.resolve(),
    log: (message) => logs.push(message),
    timers: { setTimer: () => () => undefined },
    newTaskId: () => {
      ids += 1;
      return `t${ids}`;
    },
  });
  port.onMessage(state.receive);
  return { state, sent, said, published, logs, asked: fake.asked };
}

function firstText(request: ModelRequest): string {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

// Main's state wired to the real engine and the real talker; only the models are fake.
function startFlow(script: Front[], steps: Outcome[] = []) {
  const { port, requests, workerRequests } = startFakeEngine(steps);
  const main = mainStateOn(port, script);
  const card = (taskId: string): TaskCard | undefined =>
    main.state.displayState().tasks.find((task) => task.taskId === taskId);
  const workerAsked = (goal: string) =>
    requests.some((r) => r.tools !== undefined && firstText(r).includes(goal));
  // The card as first published in a state; a later step may already have moved it on.
  const shown = (taskId: string, taskState: TaskCard["state"]) =>
    main.published
      .map((display) => display.tasks.find((task) => task.taskId === taskId))
      .find((task) => task?.state === taskState);
  return {
    ...main,
    requests,
    workerRequests,
    card,
    shown,
    until,
    firstText,
    workerAsked,
  };
}

const sentOf = (
  flow: ReturnType<typeof startFlow>,
  type: EngineCommand["type"],
  taskId: string,
) =>
  flow.sent.find(
    (command) => command.type === type && command.taskId === taskId,
  );

describe("main and the engine joined: the routes", () => {
  it("answers a greeting in the front call alone, with no engine command", async () => {
    const flow = startFlow([front("Hi, I'm Baymax.", chat())]);
    flow.state.ask("hi", null, null);
    await flow.until("the done card", () => flow.card("t1")?.state === "done");
    expect(flow.card("t1")).toMatchObject({
      reply: "Hi, I'm Baymax.",
      answer: { cardText: "Hi, I'm Baymax." },
      sayBack: null,
    });
    expect(flow.sent).toEqual([]);
    expect(flow.requests).toEqual([]);
    expect(flow.said).toEqual([]);
  });

  it("sends the decision's goal and the user's words, and the worker gets the written brief", async () => {
    const flow = startFlow(
      [front("I'll check the forecast.", newTask("the forecast"))],
      [unreachable],
    );
    flow.state.ask("will it rain in Delhi?", null, null);
    await flow.until("the worker", () => flow.workerAsked("the forecast"));
    expect(sentOf(flow, "runTask", "t1")).toMatchObject({
      ask: { goal: "the forecast", userWords: "will it rain in Delhi?" },
    });
    expect(sentOf(flow, "runTask", "t1")).not.toHaveProperty("brief");
    expect(firstText(flow.workerRequests()[0])).toContain(
      "will it rain in Delhi?",
    );
    expect(flow.shown("t1", "running")).toMatchObject({
      reply: "I'll check the forecast.",
      line: null,
    });
  });
});

describe("main and the engine joined: routes that start no worker", () => {
  it("ends outside research without a worker and leaves the line to speech", async () => {
    const flow = startFlow([front("I can't book a cab.", outsideResearch())]);
    flow.state.ask("book me a cab", null, null);
    await flow.until(
      "the cancelled card",
      () => flow.card("t1")?.state === "cancelled",
    );
    expect(flow.card("t1")).toMatchObject({
      reply: "I can't book a cab.",
      line: null,
    });
    expect(flow.sent).toEqual([]);
    expect(flow.said).toEqual([]);
  });

  it("rejects a decision that fails its check and starts no worker", async () => {
    const flow = startFlow([
      front("On it.", decision({ route: "newTask", topic: "x" })),
    ]);
    flow.state.ask("find me a laptop", null, null);
    await flow.until("the failure", () => flow.card("t1")?.canRetry === true);
    expect(flow.sent).toEqual([]);
    expect(flow.logs).toContain("decision rejected for t1: missingGoal");
  });
});

describe("main and the engine joined: a follow-up", () => {
  it("runs the typed demo pair over an incomplete parent", async () => {
    const flow = startFlow(
      [
        front(
          "I'll look at how Hermes works.",
          newTask("how Hermes agent works inside"),
        ),
        front(
          "I'll compare them.",
          followUp("t1", "how Hermes differs from Claude Code"),
        ),
      ],
      [unreachable, unreachable],
    );
    flow.state.ask("How does Hermes agent work inside?", null, null);
    await flow.until(
      "card 1 to end",
      () => flow.card("t1")?.state === "incomplete",
    );
    flow.state.ask("How is it different from Claude Code?", null, null);
    await flow.until(
      "card 2's run",
      () => sentOf(flow, "runTask", "t2") !== undefined,
    );
    const line =
      "How Hermes agent works inside ended before it found anything.";
    expect(flow.shown("t2", "running")).toMatchObject({
      parentTaskId: "t1",
      line,
      reply: "I'll compare them.",
    });
    expect(flow.said.map((said) => said.text)).not.toContain(line);
    expect(sentOf(flow, "runTask", "t2")).toMatchObject({
      parent: { taskId: "t1", outcome: "incomplete", findings: null },
    });
    // The second front call saw the first task and its line in its history.
    expect(flow.asked[1]).toContain("task t1 (incomplete)");
    await flow.until("card 2's worker request", () =>
      flow.workerAsked("how Hermes differs from Claude Code"),
    );
    expect(flow.firstText(flow.workerRequests()[1])).toContain(
      "<parent_result>",
    );
  });
});

describe("main and the engine joined: a clarifying answer", () => {
  const clarifyFront = front(
    "Which kind of laptop?",
    clarify(["Office", "Gaming"]),
  );
  const laptop = (answerTo: string | null) =>
    front("Checking office laptops.", newTask("office laptops", answerTo));

  it("continues a clarifying task answered by typed words, removing the new card", async () => {
    const flow = startFlow(
      [clarifyFront, laptop("t1:question")],
      [unreachable],
    );
    flow.state.ask("find me a good laptop", null, null);
    await flow.until(
      "the question",
      () => flow.state.waitingQuestion() !== null,
    );
    flow.state.ask("the first one", null, flow.state.waitingQuestion());
    await flow.until("the worker", () => flow.workerAsked("office laptops"));
    expect(flow.card("t2")).toBeUndefined();
    expect(sentOf(flow, "runTask", "t1")).toBeDefined();
    expect(flow.sent.map((command) => command.type)).toEqual(["runTask"]);
  });
});
