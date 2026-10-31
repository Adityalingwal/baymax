import type Anthropic from "@anthropic-ai/sdk";
import type {
  ModelCall,
  ModelFailure,
  ModelOutcome,
  ModelRequest,
} from "../../providers/anthropic";
import type { TaskId } from "../../shared/cards";
import type { DevLog } from "./dev-log";
import { costOf, lastAnswerMs, roles, taskLimits } from "./limits";
import type { Role, TaskBudget } from "./limits";

export type DispatchOutcome =
  | { ok: true; message: Anthropic.Message }
  | { ok: false; reason: "limitHit"; limit: keyof TaskBudget }
  | { ok: false; reason: "failed"; failure: ModelFailure };

export type DispatchDeps = { call: ModelCall; now: () => number; log: DevLog };

export type DispatchJob = {
  taskId: TaskId;
  role: Role;
  budget: TaskBudget;
  signal: AbortSignal;
  lastAnswer?: boolean; // the one call past the limits, sent to save the work a run ending short already did
};

type DispatchRequest = Omit<ModelRequest, "model" | "max_tokens">;

// A conservative estimate: the serialized request at about 3 characters per token, plus the full output ceiling.
function limitReached(
  job: DispatchJob,
  request: DispatchRequest,
): keyof TaskBudget | null {
  const { budget, role } = job;
  if (budget.modelCalls >= taskLimits.modelCalls) return "modelCalls";
  if (budget.activeMs >= taskLimits.activeMs) return "activeMs";
  const estimate = costOf(roles[role].model, {
    input_tokens: Math.ceil(JSON.stringify(request).length / 3),
    output_tokens: roles[role].maxTokens,
  });
  if (budget.dollars + estimate > taskLimits.dollars) return "dollars";
  return null;
}

// A call's deadline is capped by the time left, so one cut off there ran out of time; it says nothing about the provider.
function ranOutOfTime(job: DispatchJob, outcome: ModelOutcome): boolean {
  return (
    !outcome.ok &&
    outcome.failure === "unreachable" &&
    job.lastAnswer !== true &&
    job.budget.activeMs >= taskLimits.activeMs - 1_000
  );
}

// The SDK rejects a non-integer timeout, and the clock gives fractions.
function callTimes({ role, budget, lastAnswer }: DispatchJob) {
  if (lastAnswer === true) {
    return { timeoutMs: lastAnswerMs, deadlineMs: lastAnswerMs };
  }
  const remaining = taskLimits.activeMs - budget.activeMs;
  const attempt = roles[role].timeoutMs;
  return {
    timeoutMs: Math.max(1, Math.floor(Math.min(attempt, remaining))),
    deadlineMs: Math.max(
      1,
      Math.floor(Math.min(2 * attempt + 5_000, remaining)),
    ),
  };
}

type CallRecord = { outcome: ModelOutcome; ms: number; dollars: number | null };

function logCall(
  deps: DispatchDeps,
  job: DispatchJob,
  record: CallRecord,
): void {
  const { outcome, ms, dollars } = record;
  const usage = outcome.ok ? outcome.message.usage : null;
  deps.log({
    event: "modelCall",
    taskId: job.taskId,
    role: job.role,
    model: roles[job.role].model,
    maxTokens: roles[job.role].maxTokens,
    outcome: outcome.ok ? "ok" : outcome.failure,
    stopReason: outcome.ok ? outcome.message.stop_reason : null,
    ms,
    inputTokens: usage ? usage.input_tokens : null,
    outputTokens: usage ? usage.output_tokens : null,
    cacheWriteTokens: usage ? (usage.cache_creation_input_tokens ?? 0) : null,
    cacheReadTokens: usage ? (usage.cache_read_input_tokens ?? 0) : null,
    dollars,
    taskDollars: job.budget.dollars,
    ...(outcome.ok ? {} : { detail: outcome.detail }),
  });
}

function limitOutcome(
  deps: DispatchDeps,
  job: DispatchJob,
  limit: keyof TaskBudget,
): DispatchOutcome {
  deps.log({ event: "limitHit", taskId: job.taskId, role: job.role, limit });
  return { ok: false, reason: "limitHit", limit };
}

export async function dispatch(
  deps: DispatchDeps,
  job: DispatchJob,
  request: DispatchRequest,
): Promise<DispatchOutcome> {
  // A cancelled job sends nothing and spends nothing.
  if (job.signal.aborted)
    return { ok: false, reason: "failed", failure: "aborted" };
  const limit = job.lastAnswer === true ? null : limitReached(job, request);
  if (limit !== null) return limitOutcome(deps, job, limit);
  const { model, maxTokens } = roles[job.role];
  const started = deps.now();
  const outcome = await deps.call(
    { ...request, model, max_tokens: maxTokens },
    { ...callTimes(job), signal: job.signal },
  );
  const ms = deps.now() - started;
  const dollars = outcome.ok ? costOf(model, outcome.message.usage) : null;
  job.budget.modelCalls += 1;
  job.budget.activeMs += ms;
  job.budget.dollars += dollars ?? 0;
  logCall(deps, job, { outcome, ms, dollars });
  if (ranOutOfTime(job, outcome)) return limitOutcome(deps, job, "activeMs");
  return outcome.ok
    ? { ok: true, message: outcome.message }
    : { ok: false, reason: "failed", failure: outcome.failure };
}
