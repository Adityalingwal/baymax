import type Anthropic from "@anthropic-ai/sdk";
import type { ContentsFn, SearchFn } from "../../../providers/exa";
import type { Findings, TaskId } from "../../../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  FailureCause,
  ProgressStep,
} from "../../../shared/engine";
import type { DevLogEntry } from "../../core/dev-log";
import type { DispatchDeps } from "../../core/dispatch";
import type { FoundSoFar } from "../../core/holds";
import type { TaskBudget } from "../../core/limits";
import type { LoopEnding, ToolTurn } from "../../core/tool-batch";
import { runLastAnswer, runWorkerLoop } from "../../core/worker-loop";
import type {
  LoopOutcome,
  WorkerLoop,
  WorkerPrompt,
} from "../../core/worker-loop";
import { answerSchema, foundFindings } from "./answer";
import type { Connect, LookupAll } from "./connection";
import { runRounds } from "./rounds";
import type { Rounds, WorkTurn } from "./rounds";
import { createToolRunner, researchTools } from "./tool-runner";
import { hostOf } from "./url-rules";
import { createWebTool } from "./web-tool";
import {
  firstWorkerMessage,
  lastAnswerText,
  workerInstructions,
} from "./worker-prompt";

export type RunTaskCommand = Extract<EngineCommand, { type: "runTask" }>;

// The web tool's outside world: the search and page-contents calls, and DNS and sockets for the fallback reader.
export type WebAccess = {
  search: SearchFn;
  contents: ContentsFn;
  lookup?: LookupAll;
  connect?: Connect;
};

type ResearchRun = {
  deps: DispatchDeps;
  task: { taskId: TaskId; budget: TaskBudget; signal: AbortSignal };
  command: RunTaskCommand;
  access: WebAccess;
  today: string;
  found: FoundSoFar; // set at the start, so the hold can read it on a cancel or a throw
  progress: (event: EngineEvent) => void; // the caller drops it once the task is cancelled
};

// Built once: the prompt start is byte-identical for every step and every task.
const workerPrompt: WorkerPrompt = {
  system: workerInstructions,
  tools: researchTools,
  schema: answerSchema,
  thinking: { type: "adaptive" },
  effort: "medium",
};

type Worker = {
  run: ResearchRun;
  history: Anthropic.MessageParam[];
  runTools: (blocks: Anthropic.ToolUseBlock[]) => Promise<ToolTurn>;
};

const causeOf = (ending: LoopEnding): FailureCause =>
  ending.kind === "limitHit" ? "limitHit" : ending.cause;

const loopOf = ({ run, runTools }: Worker): WorkerLoop => ({
  deps: run.deps,
  job: { ...run.task, role: "worker" },
  prompt: workerPrompt,
  runTools,
});

function workTurn({ run }: Worker, outcome: LoopOutcome): WorkTurn {
  if (outcome.kind === "aborted" || run.task.signal.aborted) {
    return { kind: "aborted" };
  }
  return outcome.kind === "end"
    ? { kind: "short", cause: causeOf(outcome.ending) }
    : { kind: "turn", turn: outcome };
}

// The worker loop in the shared conversation, until its next answer turn or an ending.
async function work(worker: Worker): Promise<WorkTurn> {
  const outcome = await runWorkerLoop(loopOf(worker), worker.history);
  return workTurn(worker, outcome);
}

async function lastAnswer(worker: Worker): Promise<WorkTurn> {
  const outcome = await runLastAnswer(
    loopOf(worker),
    worker.history,
    lastAnswerText,
  );
  return workTurn(worker, outcome);
}

function startRounds(run: ResearchRun): Rounds {
  const { taskId } = run.task;
  const web = createWebTool(run.access);
  let kept: Findings | null = null;
  run.found.current = () => foundFindings(kept, web.pages());
  // A valid answer ends the run at once, so a run that ends short shows only the pages it read.
  const endShort = (cause: FailureCause): EngineEvent => ({
    type: "failed",
    taskId,
    cause,
    reason: null,
    findings: foundFindings(null, web.pages()),
  });
  const job = { ...run.task, role: "worker" as const };
  const progress = (step: ProgressStep) =>
    run.progress({ type: "progress", taskId, step });
  const first = firstWorkerMessage({
    today: run.today,
    ask: run.command.ask,
    parent: run.command.parent,
  });
  const history: Anthropic.MessageParam[] = [{ role: "user", content: first }];
  const { runTools, seen } = createToolRunner({
    web,
    deps: run.deps,
    job,
    progress,
  });
  const worker = { run, history, runTools };
  return {
    deps: run.deps,
    taskId,
    pages: web.pages,
    seen,
    history,
    work: () => work(worker),
    lastAnswer: () => lastAnswer(worker),
    keep: (findings) => (kept = findings),
    endShort,
  };
}

function findingsOf(event: EngineEvent): Findings | null {
  return event.type === "result" || event.type === "failed"
    ? event.findings
    : null;
}

// Hostnames only: a URL's path or query can carry the user's words.
// One entry for a terminal event that carries findings: its source ids and their hosts, in sources order.
function cardSourcesEntry(
  taskId: string,
  event: EngineEvent | null,
): DevLogEntry | null {
  const findings = event === null ? null : findingsOf(event);
  if (findings === null) return null;
  return {
    event: "cardSources",
    taskId,
    sourceIds: findings.sources.map(({ id }) => id).join(","),
    hosts: findings.sources.map(({ url }) => hostOf(url) ?? "").join(","),
  };
}

// One task's research. Returns its one terminal event, or null once cancelled; progress goes out on the way.
export async function runResearch(
  run: ResearchRun,
): Promise<EngineEvent | null> {
  const event = await runRounds(startRounds(run));
  const entry = cardSourcesEntry(run.task.taskId, event);
  if (entry !== null) run.deps.log(entry);
  return event;
}
