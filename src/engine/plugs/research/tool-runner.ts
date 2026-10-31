import type Anthropic from "@anthropic-ai/sdk";
import type { SearchFailure } from "../../../providers/exa";
import type { FailureKind, ProgressStep } from "../../../shared/engine";
import type { DispatchDeps, DispatchJob } from "../../core/dispatch";
import { taskLimits } from "../../core/limits";
import { runToolBatch } from "../../core/tool-batch";
import type { ToolStep, ToolTurn } from "../../core/tool-batch";
import { hostOf } from "./url-rules";
import { pageForModel, searchHitsForModel } from "./model-text";
import type { ReadOutcome, WebTool } from "./web-tool";

type ToolRunner = {
  web: WebTool;
  deps: DispatchDeps;
  job: DispatchJob;
  progress: (step: ProgressStep) => void;
};

type Counts = {
  searches: number;
  failedSearches: number;
  hitsSeen: number;
  readsTried: number; // a refused or failed read counts as tried
};

export type ToolsSeen = Pick<Counts, "hitsSeen" | "readsTried">;

type ResearchCall =
  | { id: string; tool: "search"; query: string }
  | { id: string; tool: "read"; url: string };

const searchEnding = (cause: FailureKind): ToolStep => ({
  kind: "end",
  ending: { kind: "error", cause },
});

// The worker's only tools, both from the one web tool; the list never changes, so the prompt start stays cached.
export const researchTools: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "Search the web. Returns titles, URLs and snippets; snippets cannot be cited, so read a page to cite it.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description:
      "Read one web page by its URL. Returns its text with a source id you can cite.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http or https URL to read." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

function onlyString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== key) return null;
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

function callFrom(block: Anthropic.ToolUseBlock): ResearchCall | null {
  if (block.name === "search") {
    const query = onlyString(block.input, "query");
    return query === null ? null : { id: block.id, tool: "search", query };
  }
  if (block.name === "read") {
    const url = onlyString(block.input, "url");
    return url === null ? null : { id: block.id, tool: "read", url };
  }
  return null;
}

// Tool input is unchecked model output: one unknown tool or malformed argument rejects the whole turn.
function parseCalls(blocks: Anthropic.ToolUseBlock[]): ResearchCall[] | null {
  const calls = blocks.map(callFrom);
  return calls.every((call) => call !== null) ? calls : null;
}

function counterLine(runner: ToolRunner, counts: Counts): string {
  const searches = taskLimits.searches - counts.searches;
  const steps = taskLimits.modelCalls - runner.job.budget.modelCalls;
  const pages = runner.web.pages().length;
  return `Pages read: ${pages}. Searches left: ${searches}. Steps left: ${Math.max(0, steps)}.`;
}

function logTool(
  runner: ToolRunner,
  tool: ResearchCall["tool"],
  outcome: string,
  started: number,
  extra: Record<string, string | null> = {},
): void {
  runner.deps.log({
    event: "toolCall",
    taskId: runner.job.taskId,
    tool,
    outcome,
    ms: runner.deps.now() - started,
    ...extra,
  });
}

// Hostnames only: where the worker asked to read, and where a kept page really came from.
function readLogFields(
  asked: string,
  outcome: ReadOutcome,
): Record<string, string | null> {
  const host = hostOf(asked);
  if (outcome.ok) {
    const { id, url } = outcome.page;
    return { host, sourceId: id, keptHost: hostOf(url) };
  }
  return outcome.cause === "refused" ? { host, rule: outcome.rule } : { host };
}

function report(
  runner: ToolRunner,
  signal: AbortSignal,
  step: ProgressStep,
): void {
  if (!signal.aborted) runner.progress(step);
}

// Key and quota failures end the task at once; other failures are told to the worker, and the second in a row ends it.
function searchFailed(
  runner: ToolRunner,
  counts: Counts,
  cause: SearchFailure,
): ToolStep {
  if (cause === "aborted") return { kind: "aborted" };
  if (cause === "keyRejected") return searchEnding("searchKeyRejected");
  if (cause === "quota") return searchEnding("searchQuota");
  counts.failedSearches += 1;
  if (counts.failedSearches >= 2) return searchEnding("searchDown");
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
  counts.failedSearches = 0;
  counts.hitsSeen += outcome.hits.length;
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
  const fields = readLogFields(call.url, outcome);
  logTool(runner, "read", outcome.ok ? "ok" : outcome.cause, started, fields);
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
  if (call.tool === "read") {
    counts.readsTried += 1;
    return read(runner, counts, call, signal);
  }
  if (counts.searches >= taskLimits.searches) {
    logTool(runner, "search", "limitHit", runner.deps.now());
    return { kind: "end", ending: { kind: "limitHit" } };
  }
  counts.searches += 1;
  return search(runner, counts, call, signal);
}

// One runner per task: its counts last for the whole run.
export function createToolRunner(runner: ToolRunner): {
  runTools: (blocks: Anthropic.ToolUseBlock[]) => Promise<ToolTurn>;
  seen: () => ToolsSeen;
} {
  const counts: Counts = {
    searches: 0,
    failedSearches: 0,
    hitsSeen: 0,
    readsTried: 0,
  };
  const runTools = async (
    blocks: Anthropic.ToolUseBlock[],
  ): Promise<ToolTurn> => {
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
  return { runTools, seen: () => ({ ...counts }) };
}
