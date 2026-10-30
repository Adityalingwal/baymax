import type Anthropic from "@anthropic-ai/sdk";
import type { Findings, TaskId } from "../../../shared/cards";
import type { EngineEvent, FailureCause } from "../../../shared/engine";
import type { DispatchDeps } from "../../core/dispatch";
import { checkAnswer, parseAnswer } from "./answer";
import type { ReadPage } from "./page-text";
import { rewriteMessage } from "./worker-prompt";
import type { AnswerFault } from "./worker-prompt";

export type KeptAnswer = { findings: Findings; spokenLine: string };

export type WorkTurn =
  | {
      kind: "turn";
      turn: { kind: "answer"; text: string } | { kind: "cutOff" };
    }
  | { kind: "event"; event: EngineEvent }
  | { kind: "aborted" };

// One task's conversation: the rewrite appends to the same history, so the cached prefix holds.
export type Rounds = {
  deps: DispatchDeps;
  taskId: TaskId;
  pages: () => ReadPage[];
  history: Anthropic.MessageParam[];
  work: () => Promise<WorkTurn>;
  keep: (answer: KeptAnswer) => void; // told each answer that passes the check, and only those
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

function checkedTurn(rounds: Rounds, json: string): RoundEnd {
  const { taskId } = rounds;
  const answer = parseAnswer(json);
  if (answer === null) {
    rounds.deps.log({ event: "answerMalformed", taskId });
    return { kind: "fault", fault: "malformed" };
  }
  const check = checkAnswer(answer, rounds.pages());
  logCheck(rounds, check.kind === "invalid" ? check.fault : null);
  if (check.kind === "invalid") return { kind: "fault", fault: check.fault };
  if (check.kind === "nothingFound") {
    const { reason } = check;
    const event: EngineEvent = {
      type: "failed",
      taskId,
      cause: "nothingFound",
      reason,
      findings: null,
    };
    return { kind: "event", event };
  }
  const { spokenLine, findings } = check;
  rounds.keep({ findings, spokenLine });
  const event: EngineEvent = { type: "result", taskId, spokenLine, findings };
  return { kind: "event", event };
}

async function answerRound(rounds: Rounds): Promise<RoundEnd> {
  const work = await rounds.work();
  if (work.kind !== "turn") return work;
  if (work.turn.kind === "cutOff") return { kind: "fault", fault: "cutOff" };
  return checkedTurn(rounds, work.turn.text);
}

// One answer and, for a cut-off, malformed or invalid one, exactly one rewrite with its fault named.
export async function runRounds(rounds: Rounds): Promise<EngineEvent | null> {
  let end = await answerRound(rounds);
  if (end.kind === "fault") {
    const { fault } = end;
    rounds.deps.log({ event: "answerRewrite", taskId: rounds.taskId, fault });
    rounds.history.push({ role: "user", content: rewriteMessage(fault) });
    end = await answerRound(rounds);
  }
  if (end.kind === "fault") return rounds.endShort("error");
  return end.kind === "event" ? end.event : null;
}
