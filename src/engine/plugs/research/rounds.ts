import type Anthropic from "@anthropic-ai/sdk";
import type { Findings, TaskId } from "../../../shared/cards";
import type { EngineEvent, Incomplete } from "../../../shared/engine";
import type { DispatchDeps } from "../../core/dispatch";
import { answerFindings, checkAnswer, parseAnswer } from "./answer";
import type { Answer } from "./answer";
import type { ReadPage } from "./page-text";
import {
  answerFaults,
  nudgeMessage,
  retryMessage,
  thinNudgeMessage,
} from "./worker-prompt";

// What one answer's check needs from its run; built is told each card the code check builds, with its answer's spoken line.
export type CheckRun = {
  deps: DispatchDeps;
  task: { taskId: TaskId };
  pages: () => ReadPage[];
  found: () => Findings | null;
  built: (findings: Findings, spokenLine: string) => void;
};

// A failed check that earns a retry round. Stage and rule are code-defined, for the log; part is for the worker.
// findings is the checked card, for the ending after the last round; an answer that never parsed has none.
type FaultBase = { rule: string; part: string };
type Fault =
  | (FaultBase & { stage: "answer"; findings: null })
  | (FaultBase & { stage: "code"; findings: Findings });

// An answer turn as the round sees it, read once: cut off, not valid, or a parsed answer.
type AnswerTurn =
  | { kind: "cutOff" }
  | { kind: "malformed" }
  | { kind: "answer"; answer: Answer };

type RoundEnd =
  | { kind: "event"; event: EngineEvent }
  | { kind: "fault"; fault: Fault }
  | { kind: "aborted" };

// What the worker loop gave back: an answer turn to check, an ending, or a cancel.
export type WorkTurn =
  | {
      kind: "turn";
      turn: { kind: "answer"; text: string } | { kind: "cutOff" };
    }
  | { kind: "event"; event: EngineEvent }
  | { kind: "aborted" };

// One task's conversation: every round appends to the same history, so the cached prefix holds.
export type Rounds = {
  checks: CheckRun;
  history: Anthropic.MessageParam[];
  work: () => Promise<WorkTurn>;
  researchMark: () => number; // grows only with new research: a search with results or a newly kept page
};

export function incomplete(taskId: TaskId, value: Incomplete): EngineEvent {
  return { type: "incomplete", taskId, incomplete: value };
}

const ended = (event: EngineEvent): RoundEnd => ({ kind: "event", event });

function logCheck(run: CheckRun, stage: "code", failed: string | null): void {
  run.deps.log({
    event: "doneCheck",
    taskId: run.task.taskId,
    stage,
    passed: failed === null,
    failed,
  });
}

// Thin sources and a question for the user are told as they are: no retry.
function statusEvent(run: CheckRun, answer: Answer): EngineEvent {
  const { taskId } = run.task;
  const card = answerFindings(answer, run.pages());
  run.built(card, answer.spokenLine.trim());
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

// One answer turn through its check: a passed code check ends the task as a result.
export async function checkRound(
  run: CheckRun,
  turn: AnswerTurn,
): Promise<RoundEnd> {
  if (turn.kind !== "answer") return answerFault(turn.kind);
  const { answer } = turn;
  if (answer.status !== "complete") return ended(statusEvent(run, answer));
  const check = checkAnswer(answer, run.pages());
  const spokenLine = answer.spokenLine.trim();
  run.built(check.findings, spokenLine);
  logCheck(run, "code", check.passed ? null : check.rule);
  if (check.passed) {
    const { taskId } = run.task;
    const { findings } = check;
    return ended({ type: "result", taskId, spokenLine, findings });
  }
  const { rule, uncheckedPart: part, findings } = check;
  return { kind: "fault", fault: { stage: "code", rule, part, findings } };
}

const retryRounds = 2;

const eventOf = (end: Exclude<RoundEnd, { kind: "fault" }>) =>
  end.kind === "event" ? end.event : null;

function log(rounds: Rounds, event: string, round: number, fault?: Fault) {
  rounds.checks.deps.log({
    event,
    taskId: rounds.checks.task.taskId,
    round,
    ...(fault === undefined ? {} : { stage: fault.stage, rule: fault.rule }),
  });
}

// Only an answer that would be checked is held back for research; a cut-off, invalid or status answer goes on as it is.
function wouldBeChecked(turn: AnswerTurn): boolean {
  return turn.kind === "answer" && turn.answer.status === "complete";
}

type ThinNudge = { nudged: boolean };

function zeroReadThin(rounds: Rounds, turn: AnswerTurn): boolean {
  return (
    turn.kind === "answer" &&
    turn.answer.status === "sourcesThin" &&
    rounds.checks.pages().length === 0
  );
}

// One round up to its checked answer. A research round whose answer came without new research gets one nudge, and its next answer is checked as it is.
async function answeredRound(
  rounds: Rounds,
  round: number,
  research: boolean,
  thin: ThinNudge,
): Promise<RoundEnd> {
  const start = rounds.researchMark();
  let nudged = !research;
  for (;;) {
    const work = await rounds.work();
    if (work.kind === "aborted") return work;
    if (work.kind === "event") return work;
    const turn = readTurn(rounds.checks, work.turn);
    if (!thin.nudged && zeroReadThin(rounds, turn)) {
      thin.nudged = true;
      nudged = true;
      log(rounds, "thinNudge", round);
      rounds.history.push({ role: "user", content: thinNudgeMessage });
      continue;
    }
    const unresearched = rounds.researchMark() === start;
    if (nudged || !unresearched || !wouldBeChecked(turn)) {
      return checkRound(rounds.checks, turn);
    }
    nudged = true;
    log(rounds, "retryNudge", round);
    rounds.history.push({ role: "user", content: nudgeMessage });
  }
}

// After the last round, a fault that still stands ends incomplete, never as a result.
function lastEnding(
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

// The first round and up to two retry rounds in one conversation: at most three checked answers, never a fourth.
export async function runRounds(rounds: Rounds): Promise<EngineEvent | null> {
  const thin: ThinNudge = { nudged: false };
  let end = await answeredRound(rounds, 0, false, thin);
  for (let round = 1; round <= retryRounds; round += 1) {
    if (end.kind !== "fault") return eventOf(end);
    log(rounds, "retryRound", round, end.fault);
    rounds.history.push({ role: "user", content: retryMessage(end.fault) });
    end = await answeredRound(
      rounds,
      round,
      end.fault.stage !== "answer",
      thin,
    );
  }
  if (end.kind !== "fault") return eventOf(end);
  return lastEnding(
    rounds.checks.task.taskId,
    end.fault,
    rounds.checks.found(),
  );
}
