import type Anthropic from "@anthropic-ai/sdk";
import type { Findings, TaskId } from "../../../shared/cards";
import type { EngineEvent, FailureCause } from "../../../shared/engine";
import type { DispatchDeps } from "../../core/dispatch";
import { checkAnswer, foundFindings, parseAnswer } from "./answer";
import type { ReadPage } from "./page-text";
import type { ToolsSeen } from "./tool-runner";
import { rewriteMessage } from "./worker-prompt";
import type { AnswerFault } from "./worker-prompt";

export type WorkTurn =
  | {
      kind: "turn";
      turn:
        | { kind: "answer"; text: string }
        | { kind: "cutOff" }
        | { kind: "malformed" };
    }
  | { kind: "short"; cause: FailureCause }
  | { kind: "aborted" };

// One task's conversation: the rewrite appends to the same history, so the cached prefix holds.
export type Rounds = {
  deps: DispatchDeps;
  taskId: TaskId;
  pages: () => ReadPage[];
  seen: () => ToolsSeen;
  history: Anthropic.MessageParam[];
  work: () => Promise<WorkTurn>;
  lastAnswer: () => Promise<WorkTurn>; // one call, for a run that ended short with pages read
  keep: (findings: Findings) => void; // told only a card that passed the check, so a cancel racing the result still carries it
  endShort: (cause: FailureCause) => EngineEvent;
};

type RoundEnd =
  | { kind: "event"; event: EngineEvent }
  | { kind: "fault"; fault: AnswerFault }
  | { kind: "aborted" };

function logCheck(rounds: Rounds, failed: string | null): void {
  rounds.deps.log({
    event: "doneCheck",
    taskId: rounds.taskId,
    passed: failed === null,
    failed,
  });
}

function malformedTurn(rounds: Rounds): RoundEnd {
  rounds.deps.log({ event: "answerMalformed", taskId: rounds.taskId });
  return { kind: "fault", fault: "malformed" };
}

// Gave up on search results without trying a single page.
function neverRead(rounds: Rounds): boolean {
  const { hitsSeen, readsTried } = rounds.seen();
  return hitsSeen > 0 && readsTried === 0 && rounds.pages().length === 0;
}

function checkedTurn(
  rounds: Rounds,
  json: string,
  firstRound: boolean,
): RoundEnd {
  const { taskId } = rounds;
  const answer = parseAnswer(json);
  if (answer === null) return malformedTurn(rounds);
  const check = checkAnswer(answer, rounds.pages());
  if (firstRound && check.kind === "nothingFound" && neverRead(rounds)) {
    logCheck(rounds, "noPageRead");
    return { kind: "fault", fault: "noPageRead" };
  }
  logCheck(rounds, check.kind === "invalid" ? check.fault : null);
  if (check.kind === "invalid") return { kind: "fault", fault: check.fault };
  if (check.kind === "nothingFound") {
    const { reason } = check;
    const event: EngineEvent = {
      type: "failed",
      taskId,
      cause: "nothingFound",
      reason,
      findings: foundFindings(null, rounds.pages()),
    };
    return { kind: "event", event };
  }
  const { spokenLine, findings } = check;
  rounds.keep(findings);
  const event: EngineEvent = { type: "result", taskId, spokenLine, findings };
  return { kind: "event", event };
}

const shortEvent = (rounds: Rounds, cause: FailureCause): RoundEnd => ({
  kind: "event",
  event: rounds.endShort(cause),
});

// The last chance to save the work: only a valid or nothing-found answer counts, and it never gets a rewrite.
async function lastAnswerRound(
  rounds: Rounds,
  cause: FailureCause,
): Promise<RoundEnd> {
  const ended = (how: string, end: RoundEnd): RoundEnd => {
    const { taskId } = rounds;
    rounds.deps.log({ event: "lastAnswer", taskId, cause, how });
    return end;
  };
  const short = () => shortEvent(rounds, cause);
  const work = await rounds.lastAnswer();
  if (work.kind === "aborted") return ended("cancelled", work);
  if (work.kind === "short") return ended("failedCall", short());
  if (work.turn.kind !== "answer") return ended(work.turn.kind, short());
  const end = checkedTurn(rounds, work.turn.text, false);
  if (end.kind === "fault") return ended(end.fault, short());
  const isResult = end.kind === "event" && end.event.type === "result";
  return ended(isResult ? "result" : "nothingFound", end);
}

const savedByLastAnswer: readonly FailureCause[] = ["limitHit", "searchDown"];

async function answerRound(
  rounds: Rounds,
  firstRound: boolean,
): Promise<RoundEnd> {
  const work = await rounds.work();
  if (work.kind === "aborted") return work;
  if (work.kind === "short") {
    const { cause } = work;
    return savedByLastAnswer.includes(cause) && rounds.pages().length > 0
      ? lastAnswerRound(rounds, cause)
      : shortEvent(rounds, cause);
  }
  if (work.turn.kind === "cutOff") return { kind: "fault", fault: "cutOff" };
  if (work.turn.kind === "malformed") return malformedTurn(rounds);
  return checkedTurn(rounds, work.turn.text, firstRound);
}

// One answer and, for a cut-off, malformed or invalid one, or one that gave up without reading, exactly one rewrite with its fault named.
export async function runRounds(rounds: Rounds): Promise<EngineEvent | null> {
  let end = await answerRound(rounds, true);
  if (end.kind === "fault") {
    const { fault } = end;
    rounds.deps.log({ event: "answerRewrite", taskId: rounds.taskId, fault });
    rounds.history.push({ role: "user", content: rewriteMessage(fault) });
    end = await answerRound(rounds, false);
  }
  if (end.kind === "fault") return rounds.endShort("error");
  return end.kind === "event" ? end.event : null;
}
