import { describe, expect, it } from "vitest";
import type { ModelOutcome, ModelRequest } from "../providers/anthropic";
import type { EngineCommand } from "../shared/engine";
import {
  answerReply,
  question,
  questionReply,
  startTestEngine,
} from "./harness";

const words = "which one should I buy?";

const task = {
  sayBack: "which MacBook Pro to buy",
  startLine: "Okay, looking at the MacBook Pro.",
  brief: { goal: "g", resultShape: "r", sources: "s", limits: "l" },
};

const clarifyingAnswer: EngineCommand = {
  type: "clarifyingAnswer",
  taskId: "task-1",
  words,
  question: {
    questionId: "question-1",
    text: "Which laptop?",
    choices: ["MacBook Air", "MacBook Pro"],
  },
  reply: { kind: "choice", index: 1 },
  recent: [],
};

const routeEnum = (request: ModelRequest): unknown => {
  const properties = request.output_config?.format?.schema.properties;
  if (typeof properties !== "object" || properties === null) return null;
  if (!("route" in properties)) return null;
  const route = properties.route;
  if (typeof route !== "object" || route === null) return null;
  return "enum" in route ? route.enum : null;
};

describe("startEngine intake request", () => {
  it("uses the intake role and the fixed request shape", async () => {
    const engine = startTestEngine([questionReply(task)]);
    engine.port.send(question(words));
    await engine.settle(1);
    const [request] = engine.requests;
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request.max_tokens).toBe(1024);
    expect(request.thinking).toEqual({ type: "between_tools" });
    expect(request.output_config?.effort).toBe("low");
    expect(request.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(request.messages)).toContain(words);
    expect(routeEnum(request)).toEqual([
      "newTask",
      "followUp",
      "answer",
      "clarify",
      "outsideResearch",
    ]);
  });
});

describe("startEngine clarifying answer", () => {
  it("routes the completed request on the same task", async () => {
    const engine = startTestEngine([answerReply(task)]);
    engine.port.send(clarifyingAnswer);
    expect(await engine.settle(1)).toEqual([
      {
        type: "intake",
        taskId: "task-1",
        outcome: {
          route: "newTask",
          ...task,
          brief: {
            ...task.brief,
            userWords: `${words}\nAnswer to "Which laptop?": MacBook Pro`,
          },
        },
      },
    ]);
    expect(routeEnum(engine.requests[0])).toEqual([
      "newTask",
      "followUp",
      "outsideResearch",
    ]);
  });

  type Row = { name: string; step: ModelOutcome; kind: string };

  it.each<Row>([
    {
      name: "a model failure",
      step: { ok: false, failure: "unreachable", detail: "x" },
      kind: "modelsUnreachable",
    },
    {
      name: "a second clarifying question",
      step: answerReply({ route: "clarify" }),
      kind: "error",
    },
  ])("answers $name with one failure on that task", async (row) => {
    const engine = startTestEngine([row.step]);
    engine.port.send(clarifyingAnswer);
    expect(await engine.settle(1)).toEqual([
      { type: "failure", taskId: "task-1", kind: row.kind },
    ]);
  });
});

describe("startEngine dev log", () => {
  it("logs each call by task and role, without the key or the words", async () => {
    const engine = startTestEngine([questionReply(task), answerReply(task)]);
    engine.port.send(question(words));
    engine.port.send({ ...clarifyingAnswer, taskId: "task-2" });
    await engine.settle(2);
    const calls = engine.entries.filter((entry) => entry.event === "modelCall");
    expect(calls).toEqual([
      expect.objectContaining({ taskId: "task-1", role: "intake" }),
      expect.objectContaining({ taskId: "task-2", role: "intake" }),
    ]);
    const logged = JSON.stringify(engine.entries);
    expect(logged).not.toContain("test-key");
    expect(logged).not.toContain(words);
  });
});
