import { afterEach, describe, expect, it } from "vitest";
import type { DisplayState, TaskCard } from "../../shared/cards";
import type { EngineCommand, EnginePort } from "../../shared/engine";
import { startEngine } from "../../engine/index";
import type { EngineFakes } from "../../engine/index";
import type { MainState, SaidLine } from "./state";
import { createMainState } from "./state";

type ModelCall = NonNullable<EngineFakes["model"]>;
type ModelRequest = Parameters<ModelCall>[0];
type Outcome = Awaited<ReturnType<ModelCall>>;
type Message = Extract<Outcome, { ok: true }>["message"];

// A Messages API response with one JSON text block, as the SDK returns it.
function reply(fields: Record<string, unknown>): Outcome {
  const message: Message = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    container: null,
    diagnostics: null,
    content: [{ type: "text", text: JSON.stringify(fields), citations: null }],
    stop_reason: "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
  return { ok: true, message };
}

const briefParts = (goal: string) => ({
  goal,
  resultShape: "a short answer",
  sources: "the web",
  limits: "normal",
});

// An intake reply to a question command: all seven fields, unused ones null.
const questionReply = (fields: Record<string, unknown>): Outcome =>
  reply({
    sayBack: "what was asked",
    route: "newTask",
    parentTaskId: null,
    startLine: null,
    brief: null,
    clarify: null,
    reply: null,
    ...fields,
  });

const workerFails: Outcome = { ok: false, failure: "unreachable", detail: "x" };

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

const ports: EnginePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeModel(steps: Outcome[]) {
  const requests: ModelRequest[] = [];
  const model: ModelCall = async (request) => {
    requests.push(structuredClone(request));
    const step = steps.shift();
    if (step === undefined) throw new Error("no fake model step left");
    return step;
  };
  return { model, requests };
}

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

async function until(what: string, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !done(); turn += 1) await nextTurn();
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

// Main's state wired to the real engine; only the model is fake.
function startFlow(steps: Outcome[]) {
  const { model, requests } = fakeModel(steps);
  const port = startEngine(
    { anthropicKey: "test-key", searchKey: "" },
    { model, today: () => "2026-10-27", now: () => 0, log: () => undefined },
  );
  ports.push(port);
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
  workerFails,
  questionReply({
    sayBack: "how Hermes differs from Claude Code",
    route: "followUp",
    parentTaskId: "t1",
    startLine: "Okay, comparing them.",
    brief: briefParts("How Hermes differs from Claude Code"),
  }),
  workerFails,
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
    expect(flow.said).toContainEqual({
      taskId: "t2",
      text: line,
      kind: "startLine",
    });
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
    const flow = startFlow([clarify, laptopTask, workerFails]);
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
    const flow = startFlow([clarify, answer, laptopTask, workerFails]);
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
