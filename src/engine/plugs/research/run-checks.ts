import type { Findings, TaskId } from "../../../shared/cards";
import type {
  EngineEvent,
  Incomplete,
  WorkerBrief,
} from "../../../shared/engine";
import type { DispatchDeps } from "../../core/dispatch";
import { runJudge } from "../../core/judge";
import type { JudgeFlag, JudgeOutcome } from "../../core/judge";
import type { TaskBudget } from "../../core/limits";
import { parseAnswer } from "./answer";
import type { Answer } from "./answer";
import { answerFindings, checkAnswer } from "./answer-check";
import type { CodeCheck } from "./answer-check";
import { judgeInstructions, judgeMessage } from "./judge-prompt";
import type { ReadPage } from "./page-text";
import { answerFaults } from "./worker-prompt";

// What one answer's check needs from its run; built is told each card the code check builds.
export type CheckRun = {
  deps: DispatchDeps;
  task: { taskId: TaskId; budget: TaskBudget; signal: AbortSignal };
  brief: WorkerBrief;
  pages: () => ReadPage[];
  found: () => Findings | null;
  built: (findings: Findings) => void;
};

// A failed check that earns a retry round. Stage and rule are code-defined, for the log; part is for the worker.
// findings is the checked card, for the ending after the last round; an answer that never parsed has none.
type FaultBase = { rule: string; part: string };
export type Fault =
  | (FaultBase & { stage: "answer"; findings: null })
  | (FaultBase & { stage: "code"; findings: Findings })
  | (FaultBase & {
      stage: "judge";
      findings: Findings;
      flags: JudgeFlag[];
      gaps: string[];
      spokenLine: string; // trimmed
    });

// An answer turn as the round sees it, read once: cut off, not valid, or a parsed answer.
export type AnswerTurn =
  | { kind: "cutOff" }
  | { kind: "malformed" }
  | { kind: "answer"; answer: Answer };

export type RoundEnd =
  | { kind: "event"; event: EngineEvent }
  | { kind: "fault"; fault: Fault }
  | { kind: "aborted" };

export function incomplete(taskId: TaskId, value: Incomplete): EngineEvent {
  return { type: "incomplete", taskId, incomplete: value };
}

const ended = (event: EngineEvent): RoundEnd => ({ kind: "event", event });

function logCheck(
  run: CheckRun,
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

// A judge that fails its own call leaves the answer unchecked at once; only a false flag earns the retry.
function verdictEnd(
  run: CheckRun,
  verdict: Verdict,
  check: Passed,
  answer: Answer,
): RoundEnd {
  const { taskId } = run.task;
  switch (verdict.kind) {
    case "limitHit":
      return ended(
        incomplete(taskId, { kind: "limitHit", findings: run.found() }),
      );
    case "broken":
      return ended(
        incomplete(taskId, {
          kind: "unchecked",
          uncheckedPart: "the whole answer",
          findings: check.findings,
        }),
      );
    case "fail": {
      const { failed: rule, uncheckedPart: part, flags, gaps } = verdict;
      const fault: Fault = {
        stage: "judge",
        rule,
        part,
        findings: check.findings,
        flags,
        gaps,
        spokenLine: answer.spokenLine.trim(),
      };
      return { kind: "fault", fault };
    }
    case "pass": {
      const spokenLine = answer.spokenLine.trim();
      const { findings } = check;
      return ended({ type: "result", taskId, spokenLine, findings });
    }
  }
}

async function judged(
  run: CheckRun,
  answer: Answer,
  check: Passed,
): Promise<RoundEnd> {
  const verdict = await runJudge(
    run.deps,
    { ...run.task, role: "judge" },
    {
      system: judgeInstructions,
      user: judgeMessage({ brief: run.brief, answer, pages: check.cited }),
    },
  );
  if (verdict.kind === "aborted") return { kind: "aborted" };
  logCheck(run, "judge", judgeFailure(verdict));
  return verdictEnd(run, verdict, check, answer);
}

// Thin sources and a question for the user are told as they are: no judge and no retry.
function statusEvent(run: CheckRun, answer: Answer): EngineEvent {
  const { taskId } = run.task;
  const card = answerFindings(answer, run.pages());
  run.built(card);
  const findings = card.cardText.trim() === "" ? null : card;
  const { status, nextQuestion } = answer;
  if (status === "needsUser" && nextQuestion !== null) {
    return incomplete(taskId, { kind: "needsUser", nextQuestion, findings });
  }
  return incomplete(taskId, { kind: "sourcesThin", findings });
}

function answerFault(rule: keyof typeof answerFaults): RoundEnd {
  const part = answerFaults[rule];
  return {
    kind: "fault",
    fault: { stage: "answer", rule, part, findings: null },
  };
}

export function readTurn(
  run: CheckRun,
  turn: { kind: "answer"; text: string } | { kind: "cutOff" },
): AnswerTurn {
  if (turn.kind === "cutOff") return turn;
  const answer = parseAnswer(turn.text);
  if (answer !== null) return { kind: "answer", answer };
  run.deps.log({ event: "answerMalformed", taskId: run.task.taskId });
  return { kind: "malformed" };
}

// One answer turn through its checks: the code check first, the judge only for an answer that passed it.
export async function checkRound(
  run: CheckRun,
  turn: AnswerTurn,
): Promise<RoundEnd> {
  if (turn.kind !== "answer") return answerFault(turn.kind);
  const { answer } = turn;
  if (answer.status !== "complete") return ended(statusEvent(run, answer));
  const check = checkAnswer(answer, run.pages());
  run.built(check.findings);
  logCheck(run, "code", check.passed ? null : check.rule);
  if (check.passed) return judged(run, answer, check);
  const { rule, uncheckedPart: part, findings } = check;
  return { kind: "fault", fault: { stage: "code", rule, part, findings } };
}
