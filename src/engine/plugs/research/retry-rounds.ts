import type Anthropic from "@anthropic-ai/sdk";
import type { Findings, TaskId } from "../../../shared/cards";
import type { EngineEvent } from "../../../shared/engine";
import { withNotFound } from "./found";
import { checkRound, incomplete, readTurn } from "./run-checks";
import type { AnswerTurn, CheckRun, Fault, RoundEnd } from "./run-checks";
import { nudgeMessage, retryMessage, thinNudgeMessage } from "./worker-prompt";

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

// After the last round, only a goal the web could not fully meet ends as a result, with its gaps named; an unbacked claim never does.
function lastEnding(
  taskId: TaskId,
  fault: Fault,
  found: Findings | null,
): EngineEvent {
  if (fault.stage === "judge" && fault.flags.every((f) => f === "goalMet")) {
    const gaps = fault.gaps.length > 0 ? fault.gaps : [fault.part];
    const findings = withNotFound(fault.findings, gaps);
    return { type: "result", taskId, spokenLine: fault.spokenLine, findings };
  }
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
