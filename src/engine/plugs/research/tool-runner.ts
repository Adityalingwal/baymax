import type Anthropic from "@anthropic-ai/sdk";
import type { SearchFailure } from "../../../providers/search";
import type { ProgressStep } from "../../../shared/engine";
import type { DispatchDeps, DispatchJob } from "../../core/dispatch";
import { taskLimits } from "../../core/limits";
import { runToolBatch } from "../../core/tool-batch";
import type { ToolStep, ToolTurn } from "../../core/tool-batch";
import { pageForModel, searchHitsForModel } from "./model-text";
import { parseCalls } from "./research-tools";
import type { ResearchCall } from "./research-tools";
import type { WebTool } from "./web-tool";

type ToolRunner = {
  web: WebTool;
  deps: DispatchDeps;
  job: DispatchJob;
  progress: (step: ProgressStep, sourcesRead: number) => void;
};

type Counts = {
  searches: number;
  failedSearches: number;
  searchesFound: number;
};

const searchDown: ToolStep = {
  kind: "end",
  ending: { kind: "error", cause: "searchDown" },
};

function counterLine(runner: ToolRunner, counts: Counts): string {
  const searches = taskLimits.searches - counts.searches;
  // One model call stays kept for the judge.
  const steps = taskLimits.modelCalls - runner.job.budget.modelCalls - 1;
  const pages = runner.web.pages().length;
  return `Pages read: ${pages}. Searches left: ${searches}. Steps left: ${Math.max(0, steps)}.`;
}

function logTool(
  runner: ToolRunner,
  tool: ResearchCall["tool"],
  outcome: string,
  started: number,
): void {
  runner.deps.log({
    event: "toolCall",
    taskId: runner.job.taskId,
    tool,
    outcome,
    ms: runner.deps.now() - started,
  });
}

function report(
  runner: ToolRunner,
  signal: AbortSignal,
  step: ProgressStep,
): void {
  if (!signal.aborted) runner.progress(step, runner.web.pages().length);
}

// Key and quota failures end the task at once; other failures are told to the worker, and the second one ends it.
function searchFailed(
  runner: ToolRunner,
  counts: Counts,
  cause: SearchFailure,
): ToolStep {
  if (cause === "aborted") return { kind: "aborted" };
  if (cause === "keyRejected" || cause === "quota") return searchDown;
  counts.failedSearches += 1;
  if (counts.failedSearches >= 2) return searchDown;
  const content = `Search failed (${cause}). Try again or read a URL you already have.\n${counterLine(runner, counts)}`;
  return { kind: "result", content, isError: true };
}

async function search(
  runner: ToolRunner,
  counts: Counts,
  call: { query: string },
  signal: AbortSignal,
): Promise<ToolStep> {
  report(runner, signal, { tool: "search", query: call.query });
  // A progress listener may cancel synchronously, so nothing is sent after that.
  if (signal.aborted) return { kind: "aborted" };
  const started = runner.deps.now();
  const outcome = await runner.web.search(call.query, signal);
  logTool(runner, "search", outcome.ok ? "ok" : outcome.cause, started);
  if (!outcome.ok) return searchFailed(runner, counts, outcome.cause);
  if (outcome.hits.length > 0) counts.searchesFound += 1;
  const content = `${searchHitsForModel(outcome.hits)}\n\n${counterLine(runner, counts)}`;
  return { kind: "result", content, isError: false };
}

async function read(
  runner: ToolRunner,
  counts: Counts,
  call: { url: string },
  signal: AbortSignal,
): Promise<ToolStep> {
  const step: ProgressStep = { tool: "read", url: call.url };
  report(runner, signal, step);
  if (signal.aborted) return { kind: "aborted" };
  const started = runner.deps.now();
  const outcome = await runner.web.read(call.url, signal);
  logTool(runner, "read", outcome.ok ? "ok" : outcome.cause, started);
  if (!outcome.ok && outcome.cause === "aborted") return { kind: "aborted" };
  const counter = counterLine(runner, counts);
  if (!outcome.ok) {
    const content = `Could not read this page (${outcome.cause}). Try another source.\n${counter}`;
    return { kind: "result", content, isError: true };
  }
  report(runner, signal, step);
  const content = `${pageForModel(outcome.page)}\n\n${counter}`;
  return { kind: "result", content, isError: false };
}

// A search slot is taken before the first await, so parallel searches that cross the limit are counted right.
function startTool(
  runner: ToolRunner,
  counts: Counts,
  call: ResearchCall,
  signal: AbortSignal,
): ToolStep | Promise<ToolStep> {
  if (signal.aborted) return { kind: "aborted" };
  if (call.tool === "read") return read(runner, counts, call, signal);
  if (counts.searches >= taskLimits.searches) {
    logTool(runner, "search", "limitHit", runner.deps.now());
    return { kind: "end", ending: { kind: "limitHit" } };
  }
  counts.searches += 1;
  return search(runner, counts, call, signal);
}

// One runner per task: its counts last for the whole run.
// researchMark grows only with a search that returned results or a newly kept page, so a round compares it with its start.
export function createToolRunner(runner: ToolRunner): {
  runTools: (blocks: Anthropic.ToolUseBlock[]) => Promise<ToolTurn>;
  researchMark: () => number;
} {
  const counts: Counts = { searches: 0, failedSearches: 0, searchesFound: 0 };
  const runTools = async (blocks: Anthropic.ToolUseBlock[]) => {
    const calls = parseCalls(blocks);
    if (calls === null) {
      runner.deps.log({
        event: "toolCallMalformed",
        taskId: runner.job.taskId,
      });
      const broken: ToolTurn = {
        kind: "end",
        ending: { kind: "error", cause: "error" },
      };
      return broken;
    }
    return runToolBatch(calls, runner.job.signal, (call, signal) =>
      startTool(runner, counts, call, signal),
    );
  };
  const researchMark = () => counts.searchesFound + runner.web.pages().length;
  return { runTools, researchMark };
}
