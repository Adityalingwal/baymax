import type Anthropic from "@anthropic-ai/sdk";
import type { ContentsFn } from "../../../providers/page-contents";
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
import type { LoopEnding, ToolTurn } from "../../core/tool-batch";
import { runWorkerLoop } from "../../core/worker-loop";
import { answerSchema } from "./answer";
import type { WorkerBrief } from "./brief";
import { writeBrief } from "./brief-writer";
import type { Connect, LookupAll } from "./connection";
import { foundFindings } from "./found";
import { cardSourcesEntry } from "./log-hosts";
import { researchTools } from "./research-tools";
import { runRounds } from "./retry-rounds";
import type { Rounds, WorkTurn } from "./retry-rounds";
import { incomplete } from "./run-checks";
import type { CheckRun } from "./run-checks";
import { createToolRunner } from "./tool-runner";
import { createWebTool } from "./web-tool";
import {
  firstWorkerMessage,
  thinkingFields,
  workerInstructions,
  workerThinking,
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
const workerPrompt = {
  system: workerInstructions(workerThinking),
  tools: researchTools,
  schema: answerSchema,
  ...thinkingFields(workerThinking),
};

// A short ending carries what was found when the run stopped; at a limit, a found answer keeps its spoken line.
function endingEvent(
  taskId: TaskId,
  ending: LoopEnding,
  found: FoundAnswer,
): EngineEvent {
  const { findings, spokenLine } = found;
  if (ending.kind !== "limitHit") {
    return incomplete(taskId, { kind: "error", cause: ending.cause, findings });
  }
  return incomplete(
    taskId,
    spokenLine === null
      ? { kind: "limitHit", findings }
      : { kind: "limitHit", findings, spokenLine },
  );
}

type FoundAnswer = { findings: Findings | null; spokenLine: string | null };

type Worker = {
  run: ResearchRun;
  foundAnswer: () => FoundAnswer;
  history: Anthropic.MessageParam[];
  runTools: (blocks: Anthropic.ToolUseBlock[]) => Promise<ToolTurn>;
};

// The worker loop in the shared conversation, until its next answer turn or an ending.
async function work(worker: Worker): Promise<WorkTurn> {
  const { run } = worker;
  const outcome = await runWorkerLoop(
    {
      deps: run.deps,
      job: { ...run.task, role: "worker" },
      prompt: workerPrompt,
      runTools: worker.runTools,
    },
    worker.history,
  );
  if (outcome.kind === "aborted" || run.task.signal.aborted) {
    return { kind: "aborted" };
  }
  if (outcome.kind === "end") {
    const found = worker.foundAnswer();
    const event = endingEvent(run.task.taskId, outcome.ending, found);
    return { kind: "event", event };
  }
  return { kind: "turn", turn: outcome };
}

function startRounds(run: ResearchRun, brief: WorkerBrief): Rounds {
  const { taskId } = run.task;
  const web = createWebTool(run.access);
  let built: { findings: Findings; spokenLine: string } | null = null;
  const found = () => foundFindings(built?.findings ?? null, web.pages());
  // The spoken line belongs to the found card only when that card is the built answer itself.
  const foundAnswer = (): FoundAnswer => {
    const findings = found();
    const spokenLine =
      built !== null && findings === built.findings ? built.spokenLine : "";
    return { findings, spokenLine: spokenLine === "" ? null : spokenLine };
  };
  run.found.current = found;
  const job = { ...run.task, role: "worker" as const };
  const progress = (step: ProgressStep, sourcesRead: number) =>
    run.progress({ type: "progress", taskId, step, sourcesRead });
  const first = firstWorkerMessage({
    today: run.today,
    brief,
    parent: run.command.parent,
  });
  const checks: CheckRun = {
    deps: run.deps,
    task: run.task,
    pages: web.pages,
    found,
    built: (findings, spokenLine) => (built = { findings, spokenLine }),
  };
  const history: Anthropic.MessageParam[] = [{ role: "user", content: first }];
  const tools = createToolRunner({ web, deps: run.deps, job, progress });
  const worker = { run, foundAnswer, history, runTools: tools.runTools };
  return {
    checks,
    history,
    work: () => work(worker),
    researchMark: tools.researchMark,
  };
}

// One task's research: the brief first, then the rounds. Returns its one terminal event, or null once cancelled; progress goes out on the way.
export async function runResearch(
  run: ResearchRun,
): Promise<EngineEvent | null> {
  const { deps, task, command } = run;
  const brief = await writeBrief(
    deps,
    task,
    command.ask,
    command.parent,
    run.today,
  );
  if (brief === null) return null;
  const event = await runRounds(startRounds(run, brief));
  const entry = cardSourcesEntry(run.task.taskId, event);
  if (entry !== null) run.deps.log(entry);
  return event;
}
