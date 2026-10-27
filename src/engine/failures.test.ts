import { describe, expect, it } from "vitest";
import type { ModelFailure, ModelOutcome } from "../providers/anthropic";
import type { FailureKind } from "../shared/engine";
import { fakeMessage, question, startTestEngine } from "./harness";

const words = "how does Hermes agent work inside?";

const validTask = {
  sayBack: "how Hermes works inside",
  startLine: "Okay, looking at how Hermes works.",
  brief: { goal: "g", resultShape: "r", sources: "s", limits: "l" },
};

const withoutReply = JSON.stringify({
  sayBack: "how Hermes works inside",
  route: "outsideResearch",
  parentTaskId: null,
  startLine: null,
  brief: null,
  clarify: null,
});

type MalformedRow = { name: string; step: ModelOutcome; reason: string };

const malformedRows: MalformedRow[] = [
  {
    name: "invalid JSON",
    step: { ok: true, message: fakeMessage("{ not json") },
    reason: "invalidJson",
  },
  {
    name: "a missing field",
    step: { ok: true, message: fakeMessage(withoutReply) },
    reason: "wrongShape",
  },
  {
    name: "stop reason max_tokens",
    step: {
      ok: true,
      message: fakeMessage(JSON.stringify(validTask), {
        stopReason: "max_tokens",
      }),
    },
    reason: "stopReason:max_tokens",
  },
  {
    name: "stop reason refusal",
    step: {
      ok: true,
      message: fakeMessage("{}", { stopReason: "refusal" }),
    },
    reason: "stopReason:refusal",
  },
];

type FailureRow = { failure: ModelFailure; kind: FailureKind };

const failureRows: FailureRow[] = [
  { failure: "keyRejected", kind: "keyRejected" },
  { failure: "noCredit", kind: "noCredit" },
  { failure: "unreachable", kind: "modelsUnreachable" },
  { failure: "error", kind: "error" },
];

describe("startEngine malformed intake answers", () => {
  it.each(malformedRows)("$name", async (row) => {
    const engine = startTestEngine([row.step]);
    engine.port.send(question(words));
    expect(await engine.settle(1)).toEqual([
      { type: "failure", taskId: "task-1", kind: "error" },
    ]);
    expect(engine.requests).toHaveLength(1);
    expect(engine.entries).toContainEqual({
      event: "intakeMalformed",
      taskId: "task-1",
      reason: row.reason,
    });
  });
});

describe("startEngine model failures", () => {
  it.each(failureRows)("$failure", async (row) => {
    const step: ModelOutcome = { ok: false, failure: row.failure, detail: "x" };
    const engine = startTestEngine([step]);
    engine.port.send(question(words));
    expect(await engine.settle(1)).toEqual([
      { type: "failure", taskId: "task-1", kind: row.kind },
    ]);
  });
});

describe("startEngine runTask worker failures", () => {
  it.each(failureRows)("$failure", async (row) => {
    const step: ModelOutcome = { ok: false, failure: row.failure, detail: "x" };
    const engine = startTestEngine([step]);
    engine.port.send({
      type: "runTask",
      taskId: "task-1",
      goalVersion: 1,
      depth: "normal",
      brief: { ...validTask.brief, userWords: words },
      parent: null,
    });
    expect(await engine.settle(1)).toEqual([
      {
        type: "incomplete",
        taskId: "task-1",
        incomplete: { kind: "error", cause: row.kind, findings: null },
      },
    ]);
    expect(engine.requests).toHaveLength(1);
  });
});
