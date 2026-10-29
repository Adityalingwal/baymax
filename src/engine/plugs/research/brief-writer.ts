import type Anthropic from "@anthropic-ai/sdk";
import type { TaskId } from "../../../shared/cards";
import type { ParentResult, TaskAsk } from "../../../shared/engine";
import { dispatch } from "../../core/dispatch";
import type { DispatchDeps, DispatchJob } from "../../core/dispatch";
import type { TaskBudget } from "../../core/limits";
import type { WorkerBrief } from "./brief";
import {
  briefInstructions,
  briefSchema,
  briefUserMessage,
} from "./brief-prompt";

type Parts = Omit<WorkerBrief, "userWords">;

// failed carries a short code for the dev log: a model failure, "limitHit", "malformed" or "thrown".
type Asked =
  | { kind: "parts"; parts: Parts }
  | { kind: "failed"; reason: string }
  | { kind: "aborted" };

type WriterTask = { taskId: TaskId; budget: TaskBudget; signal: AbortSignal };

const partNames = ["goal", "resultShape", "sources", "limits"] as const;

// Only Sonnet 5.5 accepts this field; Opus 5.5 answers a request that carries it with a 400.
const sonnetThinking: Anthropic.ThinkingConfigParam = { type: "between_tools" };

// The parts are exactly the four strings, each non-empty once trimmed.
function partsFrom(value: unknown): Parts | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== partNames.length) return null;
  const read: Record<string, string> = {};
  for (const name of partNames) {
    const part = fields[name];
    if (typeof part !== "string" || part.trim() === "") return null;
    read[name] = part.trim();
  }
  return read as Parts;
}

function readParts(message: Anthropic.Message): Parts | null {
  if (message.stop_reason !== "end_turn") return null;
  const texts = message.content.filter((block) => block.type === "text");
  if (texts.length !== 1 || texts[0].type !== "text") return null;
  try {
    return partsFrom(JSON.parse(texts[0].text));
  } catch {
    return null;
  }
}

async function askOnce(
  deps: DispatchDeps,
  job: DispatchJob,
  user: string,
): Promise<Asked> {
  const outcome = await dispatch(deps, job, {
    system: briefInstructions,
    messages: [{ role: "user", content: user }],
    ...(job.role === "briefWriter" ? { thinking: sonnetThinking } : {}),
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: briefSchema },
    },
  });
  if (job.signal.aborted) return { kind: "aborted" };
  if (!outcome.ok) {
    if (outcome.reason === "limitHit")
      return { kind: "failed", reason: "limitHit" };
    return outcome.failure === "aborted"
      ? { kind: "aborted" }
      : { kind: "failed", reason: outcome.failure };
  }
  const parts = readParts(outcome.message);
  return parts === null
    ? { kind: "failed", reason: "malformed" }
    : { kind: "parts", parts };
}

// A thrown call is a failed step, as with the judge; only a cancel is not.
async function ask(
  deps: DispatchDeps,
  job: DispatchJob,
  user: string,
): Promise<Asked> {
  try {
    return await askOnce(deps, job, user);
  } catch {
    return job.signal.aborted
      ? { kind: "aborted" }
      : { kind: "failed", reason: "thrown" };
  }
}

function defaultBrief(ask: TaskAsk): WorkerBrief {
  return {
    goal: ask.goal,
    resultShape: "A short, clear answer to the question.",
    sources: "Reliable, recent pages.",
    limits: "Stay on the question; stop once it is answered.",
    userWords: ask.userWords,
  };
}

// The brief for the worker; null once the task is cancelled. It never fails: a default brief stands in when both models do.
export async function writeBrief(
  deps: DispatchDeps,
  task: WriterTask,
  taskAsk: TaskAsk,
  parent: ParentResult | null,
  today: string,
): Promise<WorkerBrief | null> {
  const user = briefUserMessage(today, taskAsk, parent);
  const first = await ask(deps, { ...task, role: "briefWriter" }, user);
  if (first.kind === "aborted") return null;
  if (first.kind === "parts") {
    return { ...first.parts, userWords: taskAsk.userWords };
  }
  const second = await ask(deps, { ...task, role: "briefRetry" }, user);
  if (second.kind === "aborted") return null;
  if (second.kind === "parts") {
    return { ...second.parts, userWords: taskAsk.userWords };
  }
  deps.log({
    event: "briefDefault",
    taskId: task.taskId,
    firstReason: first.reason,
    retryReason: second.reason,
  });
  return defaultBrief(taskAsk);
}
