import { afterEach, describe, expect, it } from "vitest";
import type { DisplayState, TaskCard } from "../../shared/cards";
import type { EngineCommand, EnginePort } from "../../shared/engine";
import type { ModelRequest, Outcome } from "./flow.harness";
import {
  briefParts,
  closePorts,
  questionReply,
  reply,
  startFakeEngine,
  until,
  unreachable,
} from "./flow.harness";
import type { MainState, SaidLine } from "./state";
import { createMainState } from "./state";

const clarify = questionReply({
  sayBack: "a good laptop",
  route: "clarify",
  clarify: { text: "For what use?", choices: ["Office", "Gaming"] },
});

const laptopTask = reply({
  sayBack: "a good office laptop",
  route: "newTask",
  parentTaskId: null,
  startLine: "Okay, looking at office laptops.",
  brief: briefParts("Find a good office laptop"),
});

afterEach(closePorts);

// Main's state with recording deps; send records each command and forwards it to the engine.
function mainStateOn(port: EnginePort) {
  const sent: EngineCommand[] = [];
  const said: SaidLine[] = [];
  const published: DisplayState[] = [];
  let ids = 0;
  const state: MainState = createMainState({
    send: (command) => {
      sent.push(structuredClone(command));
      port.send(command);
    },
    publish: (display) => published.push(display),
    say: (line) => said.push(line),
    silence: () => undefined,
    talk: () => undefined,
    openUrl: () => Promise.resolve(),
    log: () => undefined,
    timers: { setTimer: () => () => undefined },
    newTaskId: () => {
      ids += 1;
      return `t${ids}`;
    },
  });
  port.onMessage(state.receive);
  return { state, sent, said, published };
}

function firstText(request: ModelRequest): string {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

// Main's state wired to the real engine; only the model is fake.
function startFlow(steps: Outcome[]) {
  const { port, requests } = startFakeEngine(steps);
  const main = mainStateOn(port);
  const card = (taskId: string): TaskCard | undefined =>
    main.state.displayState().tasks.find((task) => task.taskId === taskId);
  const workerAsked = (goal: string) =>
    requests.some((r) => r.tools !== undefined && firstText(r).includes(goal));
  // The card as first published in a state; a later step may already have moved it on.
  const shown = (taskId: string, taskState: TaskCard["state"]) =>
    main.published
      .map((display) => display.tasks.find((task) => task.taskId === taskId))
      .find((task) => task?.state === taskState);
  return { ...main, requests, card, shown, until, firstText, workerAsked };
}

type Flow = ReturnType<typeof startFlow>;

const sentOf = (flow: Flow, type: EngineCommand["type"], taskId: string) =>
  flow.sent.find(
    (command) => command.type === type && command.taskId === taskId,
  );

// Both workers fail, so the first card ends incomplete with nothing found.
const demoPairSteps = (): Outcome[] => [
  questionReply({
    sayBack: "how Hermes agent works inside, from its docs",
    startLine: "Okay, looking at how Hermes works.",
    brief: briefParts("How the Hermes agent works inside"),
  }),
  unreachable,
  questionReply({
    sayBack: "how Hermes differs from Claude Code",
    route: "followUp",
    parentTaskId: "t1",
    startLine: "Okay, comparing them.",
    brief: briefParts("How Hermes differs from Claude Code"),
  }),
  unreachable,
];

describe("main and the engine joined: a follow-up", () => {
  it("runs the typed demo pair over an incomplete parent", async () => {
    const flow = startFlow(demoPairSteps());
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
    });
    // The start line shows on the card; the talker is the only voice.
    expect(flow.said.map((said) => said.text)).not.toContain(line);
    expect(sentOf(flow, "runTask", "t2")).toMatchObject({
      parent: { taskId: "t1", outcome: "incomplete", findings: null },
    });
    await flow.until("card 2's worker request", () =>
      flow.workerAsked("How Hermes differs from Claude Code"),
    );
    const worker = flow.firstText(flow.requests[3]);
    expect(worker).toContain("<parent_result>");
    expect(worker).toContain(
      "The earlier task ended incomplete before it found anything usable",
    );
  });
});

describe("main and the engine joined: a clarifying answer", () => {
  it("continues a clarifying task answered by a click", async () => {
    const flow = startFlow([clarify, laptopTask, unreachable]);
    flow.state.ask("find me a good laptop", null, null);
    await flow.until(
      "the question",
      () => flow.state.waitingQuestion() !== null,
    );
    const waiting = flow.state.waitingQuestion();
    flow.state.answerQuestion({
      taskId: "t1",
      questionId: waiting?.question.questionId ?? "",
      reply: { kind: "choice", index: 0 },
    });
    await flow.until("the worker", () =>
      flow.workerAsked("Find a good office laptop"),
    );
    expect(sentOf(flow, "clarifyingAnswer", "t1")).toMatchObject({
      reply: { kind: "choice", index: 0 },
    });
    expect(sentOf(flow, "runTask", "t1")).toBeDefined();
  });

  it("continues a clarifying task answered by typed words", async () => {
    const answer = questionReply({
      route: "answer",
      reply: { choiceIndex: 1, text: null },
    });
    const flow = startFlow([clarify, answer, laptopTask, unreachable]);
    flow.state.ask("find me a good laptop", null, null);
    await flow.until(
      "the question",
      () => flow.state.waitingQuestion() !== null,
    );
    flow.state.ask("the second one", null, flow.state.waitingQuestion());
    await flow.until("the worker", () =>
      flow.workerAsked("Find a good office laptop"),
    );
    expect(flow.card("t2")).toBeUndefined();
    expect(sentOf(flow, "clarifyingAnswer", "t1")).toMatchObject({
      reply: { kind: "choice", index: 1 },
    });
    expect(sentOf(flow, "runTask", "t1")).toBeDefined();
  });
});
