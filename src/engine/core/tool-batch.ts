import type Anthropic from "@anthropic-ai/sdk";
import type { FailureKind } from "../../shared/engine";

// How a run ends short of an answer, before any findings exist.
export type LoopEnding =
  { kind: "limitHit" } | { kind: "error"; cause: FailureKind };

export type ToolStep =
  | { kind: "result"; content: string; isError: boolean }
  | { kind: "end"; ending: LoopEnding }
  | { kind: "aborted" };

export type ToolTurn =
  | { kind: "results"; results: Anthropic.ToolResultBlockParam[] }
  | { kind: "end"; ending: LoopEnding }
  | { kind: "aborted" };

// A step decided before any await (such as a limit) comes back as a plain value, so the batch stops before starting the next tool.
export type StartTool<Call> = (
  call: Call,
  signal: AbortSignal,
) => ToolStep | Promise<ToolStep>;

type Batch = { ending: LoopEnding | null; controller: AbortController };

function stopOn(batch: Batch, step: ToolStep): ToolStep {
  if (step.kind === "end" && batch.ending === null) {
    batch.ending = step.ending;
    batch.controller.abort();
  }
  return step;
}

const broken = {
  kind: "end",
  ending: { kind: "error", cause: "error" },
} as const;

// A tool that throws ends the turn like a failed one, so every started tool still settles.
function launch<Call>(
  batch: Batch,
  start: StartTool<Call>,
  call: Call,
): Promise<ToolStep> {
  let step: ToolStep | Promise<ToolStep>;
  try {
    step = start(call, batch.controller.signal);
  } catch {
    step = broken;
  }
  if (!(step instanceof Promise)) return Promise.resolve(stopOn(batch, step));
  return step.then(
    (settled) => stopOn(batch, settled),
    () => stopOn(batch, broken),
  );
}

function resultsOf<Call extends { id: string }>(
  calls: Call[],
  steps: ToolStep[],
): ToolTurn {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.kind !== "result") return broken;
    results.push({
      type: "tool_result",
      tool_use_id: calls[index].id,
      content: step.content,
      ...(step.isError ? { is_error: true } : {}),
    });
  }
  return { kind: "results", results };
}

// Runs one turn's tool calls together; the first ending aborts the others, and every started tool settles before the turn returns.
export async function runToolBatch<Call extends { id: string }>(
  calls: Call[],
  signal: AbortSignal,
  start: StartTool<Call>,
): Promise<ToolTurn> {
  const batch: Batch = { ending: null, controller: new AbortController() };
  const onAbort = () => batch.controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const running: Promise<ToolStep>[] = [];
  for (const call of calls) {
    if (batch.ending !== null || signal.aborted) break;
    running.push(launch(batch, start, call));
  }
  const steps = await Promise.all(running);
  signal.removeEventListener("abort", onAbort);
  if (signal.aborted) return { kind: "aborted" };
  if (batch.ending !== null) return { kind: "end", ending: batch.ending };
  return resultsOf(calls, steps);
}
