import { describe, expect, it } from "vitest";
import type {
  ModelCall,
  ModelFailure,
  ModelOutcome,
} from "../../providers/anthropic";
import { fakeMessage } from "../harness";
import type { DevLogEntry } from "./dev-log";
import { dispatch } from "./dispatch";
import type { DispatchDeps } from "./dispatch";
import { createTaskBudget } from "./limits";
import type { Role, TaskBudget } from "./limits";

type CallOptions = Parameters<ModelCall>[1];
type Sent = { request: Parameters<ModelCall>[0]; options: CallOptions };

const request = { messages: [{ role: "user" as const, content: "hi" }] };

// The fake call advances the fake clock by the given milliseconds.
const setup = (outcome: ModelOutcome, advanceMs = 0) => {
  let clock = 0.25;
  const sent: Sent[] = [];
  const entries: DevLogEntry[] = [];
  const deps: DispatchDeps = {
    call: async (sentRequest, options) => {
      sent.push({ request: sentRequest, options });
      clock += advanceMs;
      return outcome;
    },
    now: () => clock,
    log: (entry) => entries.push(entry),
  };
  return { deps, sent, entries };
};

const jobFor = (role: Role, budget: TaskBudget, signal?: AbortSignal) => ({
  taskId: "task-1",
  role,
  budget,
  signal: signal ?? new AbortController().signal,
});

const okOutcome: ModelOutcome = { ok: true, message: fakeMessage("{}") };

type LimitRow = { name: string; budget: TaskBudget; limit: keyof TaskBudget };

const limitRows: LimitRow[] = [
  {
    name: "model calls at 25",
    budget: { ...createTaskBudget(), modelCalls: 25 },
    limit: "modelCalls",
  },
  {
    name: "active time at 120,000 ms",
    budget: { ...createTaskBudget(), activeMs: 120_000 },
    limit: "activeMs",
  },
  {
    name: "dollars when the estimate passes the limit",
    budget: { ...createTaskBudget(), dollars: 0.495 },
    limit: "dollars",
  },
];

type SendRow = {
  name: string;
  role: Role;
  activeMs: number;
  expected: {
    model: string;
    max_tokens: number;
    timeoutMs: number;
    deadlineMs: number;
  };
};

const sendRows: SendRow[] = [
  {
    name: "intake",
    role: "intake",
    activeMs: 0,
    expected: {
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      timeoutMs: 15_000,
      deadlineMs: 35_000,
    },
  },
  {
    name: "worker",
    role: "worker",
    activeMs: 0,
    expected: {
      model: "claude-sonnet-5-5",
      max_tokens: 2048,
      timeoutMs: 60_000,
      deadlineMs: 120_000,
    },
  },
  {
    name: "judge",
    role: "judge",
    activeMs: 0,
    expected: {
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      timeoutMs: 30_000,
      deadlineMs: 65_000,
    },
  },
  {
    name: "intake with less active time left",
    role: "intake",
    activeMs: 110_000.7,
    expected: {
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      timeoutMs: 9_999,
      deadlineMs: 9_999,
    },
  },
  {
    name: "worker with under 1 ms left",
    role: "worker",
    activeMs: 119_999.5,
    expected: {
      model: "claude-sonnet-5-5",
      max_tokens: 2048,
      timeoutMs: 1,
      deadlineMs: 1,
    },
  },
];

const failureRows: { failure: ModelFailure }[] = [
  { failure: "unreachable" },
  { failure: "keyRejected" },
];

describe("dispatch limits", () => {
  it.each(limitRows)("refuses at a limit: $name", async (row) => {
    const { deps, sent, entries } = setup(okOutcome);
    const budget = { ...row.budget };
    const outcome = await dispatch(deps, jobFor("intake", budget), request);
    expect(outcome).toEqual({
      ok: false,
      reason: "limitHit",
      limit: row.limit,
    });
    expect(sent).toHaveLength(0);
    expect(budget).toEqual(row.budget);
    expect(entries).toEqual([
      { event: "limitHit", taskId: "task-1", role: "intake", limit: row.limit },
    ]);
  });
});

describe("dispatch settings", () => {
  it.each(sendRows)("sends the role's settings: $name", async (row) => {
    const { deps, sent } = setup(okOutcome);
    const signal = new AbortController().signal;
    const budget = { ...createTaskBudget(), activeMs: row.activeMs };
    await dispatch(deps, jobFor(row.role, budget, signal), request);
    const [{ request: sentRequest, options }] = sent;
    expect(sentRequest).toEqual({
      ...request,
      model: row.expected.model,
      max_tokens: row.expected.max_tokens,
    });
    expect(options).toEqual({
      timeoutMs: row.expected.timeoutMs,
      deadlineMs: row.expected.deadlineMs,
      signal,
    });
    expect(Number.isInteger(options.timeoutMs)).toBe(true);
    expect(Number.isInteger(options.deadlineMs)).toBe(true);
  });
});

describe("dispatch counting", () => {
  it("counts an answered call, its time and its cost", async () => {
    const message = fakeMessage("{}", {
      usage: {
        input_tokens: 1_000,
        output_tokens: 500,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 2_000,
      },
    });
    const { deps, entries } = setup({ ok: true, message }, 1_234.5);
    const budget = createTaskBudget();
    const outcome = await dispatch(deps, jobFor("intake", budget), request);
    expect(outcome).toEqual({ ok: true, message });
    expect(budget).toEqual({
      modelCalls: 1,
      activeMs: 1_234.5,
      dollars: expect.closeTo(0.0084, 10),
    });
    expect(entries).toEqual([
      {
        event: "modelCall",
        taskId: "task-1",
        role: "intake",
        model: "claude-sonnet-5-5",
        outcome: "ok",
        ms: 1_234.5,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheWriteTokens: 400,
        cacheReadTokens: 2_000,
        dollars: expect.closeTo(0.0084, 10),
        taskDollars: expect.closeTo(0.0084, 10),
      },
    ]);
  });
});

describe("dispatch failures", () => {
  it.each(failureRows)(
    "counts a failed call without dollars: $failure",
    async (row) => {
      const failed: ModelOutcome = {
        ok: false,
        failure: row.failure,
        detail: "cause",
      };
      const { deps, entries } = setup(failed, 40);
      const budget = { ...createTaskBudget(), dollars: 0.01 };
      const outcome = await dispatch(deps, jobFor("judge", budget), request);
      expect(outcome).toEqual({
        ok: false,
        reason: "failed",
        failure: row.failure,
      });
      expect(budget).toEqual({ modelCalls: 1, activeMs: 40, dollars: 0.01 });
      expect(entries).toEqual([
        {
          event: "modelCall",
          taskId: "task-1",
          role: "judge",
          model: "claude-sonnet-5-5",
          outcome: row.failure,
          ms: 40,
          inputTokens: null,
          outputTokens: null,
          cacheWriteTokens: null,
          cacheReadTokens: null,
          dollars: null,
          taskDollars: 0.01,
          detail: "cause",
        },
      ]);
    },
  );
});

describe("dispatch after cancel", () => {
  it("sends nothing, counts nothing and logs nothing", async () => {
    const { deps, sent, entries } = setup({
      ok: true,
      message: fakeMessage("{}"),
    });
    const controller = new AbortController();
    controller.abort();
    const budget = createTaskBudget();
    const job = jobFor("intake", budget, controller.signal);
    expect(await dispatch(deps, job, request)).toEqual({
      ok: false,
      reason: "failed",
      failure: "aborted",
    });
    expect(sent).toHaveLength(0);
    expect(entries).toHaveLength(0);
    expect(budget).toEqual(createTaskBudget());
  });
});
