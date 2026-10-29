import { describe, expect, it } from "vitest";
import type { ModelFailure, ModelOutcome } from "../providers/anthropic";
import type { FailureKind } from "../shared/engine";
import { startTestEngine } from "./harness";
import { runTask } from "./run.harness";

type FailureRow = { failure: ModelFailure; kind: FailureKind };

const failureRows: FailureRow[] = [
  { failure: "keyRejected", kind: "keyRejected" },
  { failure: "noCredit", kind: "noCredit" },
  { failure: "unreachable", kind: "modelsUnreachable" },
  { failure: "error", kind: "error" },
];

describe("startEngine runTask worker failures", () => {
  it.each(failureRows)("$failure", async (row) => {
    const step: ModelOutcome = { ok: false, failure: row.failure, detail: "x" };
    const engine = startTestEngine([step]);
    engine.port.send(runTask());
    expect(await engine.settle(1)).toEqual([
      {
        type: "incomplete",
        taskId: "task-1",
        incomplete: { kind: "error", cause: row.kind, findings: null },
      },
    ]);
    expect(engine.loopRequests()).toHaveLength(1);
  });
});
