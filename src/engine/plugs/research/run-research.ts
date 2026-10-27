import type { SearchFn } from "../../../providers/search";
import type { Findings, TaskId } from "../../../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  Incomplete,
  ProgressStep,
} from "../../../shared/engine";
import type { DispatchDeps } from "../../core/dispatch";
import { runJudge } from "../../core/judge";
import type { JudgeOutcome } from "../../core/judge";
import type { TaskBudget } from "../../core/limits";
import type { LoopEnding } from "../../core/tool-batch";
import { runWorkerLoop } from "../../core/worker-loop";
import { parseAnswer, answerSchema } from "./answer";
import type { Answer } from "./answer";
import type { CodeCheck } from "./answer-check";
import { checkAnswer } from "./answer-check";
import type { Connect, LookupAll } from "./connection";
import { judgeInstructions, judgeMessage } from "./judge-prompt";
import { researchTools } from "./research-tools";
import { createToolRunner } from "./tool-runner";
import { createWebTool } from "./web-tool";
import type { WebTool } from "./web-tool";
import {
  firstWorkerMessage,
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

export type ResearchRun = {
  deps: DispatchDeps;
  task: { taskId: TaskId; budget: TaskBudget; signal: AbortSignal };
  command: RunTaskCommand;
  access: WebAccess;
  today: string;
  progress: (event: EngineEvent) => void; // the caller drops it once the task is cancelled
};

// Built once: the prompt start is byte-identical for every step and every task.
const workerPrompt = {
  system: workerInstructions(workerThinking),
  tools: researchTools,
  schema: answerSchema,
  ...thinkingFields(workerThinking),
};

function incomplete(taskId: TaskId, value: Incomplete): EngineEvent {
  return { type: "incomplete", taskId, incomplete: value };
}

function endingEvent(taskId: TaskId, ending: LoopEnding): EngineEvent {
  return ending.kind === "limitHit"
    ? incomplete(taskId, { kind: "limitHit", findings: null })
    : incomplete(taskId, {
        kind: "error",
        cause: ending.cause,
        findings: null,
      });
}

function logCheck(
  run: ResearchRun,
  stage: "code" | "judge",
  failed: string | null,
): void {
  run.deps.log({
    event: "doneCheck",
    taskId: run.task.taskId,
    stage,
    passed: failed === null,
    failed,
  });
}

function unchecked(taskId: TaskId, part: string, findings: Findings) {
  return incomplete(taskId, {
    kind: "unchecked",
    uncheckedPart: part,
    findings,
  });
}

type Verdict = Exclude<JudgeOutcome, { kind: "aborted" }>;
type Passed = Extract<CodeCheck, { passed: true }>;

function judgeFailure(verdict: Verdict): string | null {
  switch (verdict.kind) {
    case "pass":
      return null;
    case "fail":
      return verdict.failed;
    case "broken":
      return `broken:${verdict.reason}`;
    case "limitHit":
      return "limitHit";
  }
}

function verdictEvent(
  taskId: TaskId,
  verdict: Verdict,
  check: Passed,
  answer: Answer,
): EngineEvent {
  switch (verdict.kind) {
    case "limitHit":
      return incomplete(taskId, { kind: "limitHit", findings: null });
    case "broken":
      return unchecked(taskId, "the whole answer", check.findings);
    case "fail":
      return unchecked(taskId, verdict.uncheckedPart, check.findings);
    case "pass": {
      const spokenLine = answer.spokenLine.trim();
      return { type: "result", taskId, spokenLine, findings: check.findings };
    }
  }
}

// The code check first; the judge only for an answer that passed it.
async function checkedEvent(
  run: ResearchRun,
  answer: Answer,
  web: WebTool,
): Promise<EngineEvent | null> {
  const { taskId } = run.task;
  const check = checkAnswer(answer, web.pages());
  logCheck(run, "code", check.passed ? null : check.rule);
  if (!check.passed) {
    return unchecked(taskId, check.uncheckedPart, check.findings);
  }
  const verdict = await runJudge(
    run.deps,
    { ...run.task, role: "judge" },
    {
      system: judgeInstructions,
      user: judgeMessage({
        brief: run.command.brief,
        answer,
        pages: check.cited,
      }),
    },
  );
  if (verdict.kind === "aborted") return null;
  logCheck(run, "judge", judgeFailure(verdict));
  return verdictEvent(taskId, verdict, check, answer);
}

// One task's research: returns its one terminal event, or null once cancelled; progress goes out on the way.
export async function runResearch(
  run: ResearchRun,
): Promise<EngineEvent | null> {
  const { taskId } = run.task;
  const web = createWebTool(run.access);
  const job = { ...run.task, role: "worker" as const };
  const progress = (step: ProgressStep, sourcesRead: number) =>
    run.progress({ type: "progress", taskId, step, sourcesRead });
  const loop = await runWorkerLoop({
    deps: run.deps,
    job,
    prompt: workerPrompt,
    firstMessage: firstWorkerMessage({
      today: run.today,
      brief: run.command.brief,
      parent: run.command.parent,
    }),
    runTools: createToolRunner({ web, deps: run.deps, job, progress }),
  });
  if (loop.kind === "aborted" || run.task.signal.aborted) return null;
  if (loop.kind === "end") return endingEvent(taskId, loop.ending);
  const answer = parseAnswer(loop.text);
  if (answer === null) {
    run.deps.log({ event: "answerMalformed", taskId });
    return incomplete(taskId, {
      kind: "error",
      cause: "error",
      findings: null,
    });
  }
  return checkedEvent(run, answer, web);
}
