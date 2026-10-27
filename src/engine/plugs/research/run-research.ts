import type Anthropic from "@anthropic-ai/sdk";
import type { SearchFn } from "../../../providers/search";
import type { Findings, TaskId } from "../../../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  ProgressStep,
} from "../../../shared/engine";
import type { DispatchDeps } from "../../core/dispatch";
import type { FoundSoFar } from "../../core/holds";
import type { TaskBudget } from "../../core/limits";
import type { LoopEnding } from "../../core/tool-batch";
import { runWorkerLoop } from "../../core/worker-loop";
import { answerSchema } from "./answer";
import type { Connect, LookupAll } from "./connection";
import { foundFindings } from "./found";
import { researchTools } from "./research-tools";
import { checkRound, incomplete } from "./run-checks";
import type { CheckRun, Fault, RoundEnd } from "./run-checks";
import { createToolRunner } from "./tool-runner";
import { createWebTool } from "./web-tool";
import {
  firstWorkerMessage,
  retryMessage,
  thinkingFields,
  workerInstructions,
  workerThinking,
} from "./worker-prompt";

export type RunTaskCommand = Extract<EngineCommand, { type: "runTask" }>;

// The web tool's outside world: the search call, and DNS and sockets for page reads.
export type WebAccess = {
  search: SearchFn;
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
const workerPrompt = {
  system: workerInstructions(workerThinking),
  tools: researchTools,
  schema: answerSchema,
  ...thinkingFields(workerThinking),
};

// A short ending carries what was found when the run stopped.
function endingEvent(
  taskId: TaskId,
  ending: LoopEnding,
  findings: Findings | null,
): EngineEvent {
  return ending.kind === "limitHit"
    ? incomplete(taskId, { kind: "limitHit", findings })
    : incomplete(taskId, { kind: "error", cause: ending.cause, findings });
}

// A second failed check ends unchecked with its part; an answer that never parsed names the whole answer, when anything was found.
function failedTwice(
  taskId: TaskId,
  fault: Fault,
  found: Findings | null,
): EngineEvent {
  if (fault.findings !== null) {
    const { part: uncheckedPart, findings } = fault;
    return incomplete(taskId, { kind: "unchecked", uncheckedPart, findings });
  }
  if (found === null) {
    return incomplete(taskId, {
      kind: "error",
      cause: "error",
      findings: null,
    });
  }
  return incomplete(taskId, {
    kind: "unchecked",
    uncheckedPart: "the whole answer",
    findings: found,
  });
}

type Round = {
  run: ResearchRun;
  checks: CheckRun;
  history: Anthropic.MessageParam[];
  runTools: ReturnType<typeof createToolRunner>;
};

// One worker round in the shared conversation, then its answer's checks.
async function workerRound(round: Round): Promise<RoundEnd> {
  const { run, checks } = round;
  const outcome = await runWorkerLoop(
    {
      deps: run.deps,
      job: { ...run.task, role: "worker" },
      prompt: workerPrompt,
      runTools: round.runTools,
    },
    round.history,
  );
  if (outcome.kind === "aborted" || run.task.signal.aborted) {
    return { kind: "aborted" };
  }
  if (outcome.kind === "end") {
    const event = endingEvent(run.task.taskId, outcome.ending, checks.found());
    return { kind: "event", event };
  }
  return checkRound(checks, outcome);
}

function logRetry(run: ResearchRun, fault: Fault): void {
  run.deps.log({
    event: "retryRound",
    taskId: run.task.taskId,
    stage: fault.stage,
    rule: fault.rule,
  });
}

function startRound(run: ResearchRun): Round {
  const { taskId } = run.task;
  const web = createWebTool(run.access);
  let built: Findings | null = null;
  const found = () => foundFindings(built, web.pages());
  run.found.current = found;
  const job = { ...run.task, role: "worker" as const };
  const progress = (step: ProgressStep, sourcesRead: number) =>
    run.progress({ type: "progress", taskId, step, sourcesRead });
  const first = firstWorkerMessage({
    today: run.today,
    brief: run.command.brief,
    parent: run.command.parent,
  });
  return {
    run,
    checks: {
      deps: run.deps,
      task: run.task,
      brief: run.command.brief,
      pages: web.pages,
      found,
      built: (findings) => (built = findings),
    },
    history: [{ role: "user", content: first }],
    runTools: createToolRunner({ web, deps: run.deps, job, progress }),
  };
}

const eventOf = (end: Exclude<RoundEnd, { kind: "fault" }>) =>
  end.kind === "event" ? end.event : null;

// One task's research: returns its one terminal event, or null once cancelled; progress goes out on the way.
// A failed check gets one more round in the same conversation, and never a third.
export async function runResearch(
  run: ResearchRun,
): Promise<EngineEvent | null> {
  const round = startRound(run);
  const first = await workerRound(round);
  if (first.kind !== "fault") return eventOf(first);
  logRetry(run, first.fault);
  round.history.push({ role: "user", content: retryMessage(first.fault.part) });
  const second = await workerRound(round);
  if (second.kind !== "fault") return eventOf(second);
  return failedTwice(run.task.taskId, second.fault, round.checks.found());
}
