import type { FailureKind, IntakeOutcome } from "../../shared/engine";
import { dispatch } from "./dispatch";
import type { DispatchDeps, DispatchJob, DispatchOutcome } from "./dispatch";
import { buildUserMessage, intakeInstructions } from "./intake-prompt";
import type { IntakeCommand } from "./intake-prompt";
import {
  checkIntakeReply,
  clarifyingAnswerSchema,
  questionSchema,
} from "./intake-schema";

export type IntakeResult =
  | { kind: "intake"; outcome: IntakeOutcome }
  | { kind: "failure"; failure: FailureKind }
  | { kind: "aborted" };

type DispatchFailure = Exclude<DispatchOutcome, { ok: true }>;

function failureResult(outcome: DispatchFailure): IntakeResult {
  if (outcome.reason === "limitHit") {
    return { kind: "failure", failure: "error" };
  }
  switch (outcome.failure) {
    case "aborted":
      return { kind: "aborted" };
    case "keyRejected":
      return { kind: "failure", failure: "keyRejected" };
    case "noCredit":
      return { kind: "failure", failure: "noCredit" };
    case "unreachable":
      return { kind: "failure", failure: "modelsUnreachable" };
    case "error":
      return { kind: "failure", failure: "error" };
  }
}

export async function runIntake(
  deps: DispatchDeps,
  job: DispatchJob,
  command: IntakeCommand,
): Promise<IntakeResult> {
  const schema =
    command.type === "question" ? questionSchema : clarifyingAnswerSchema;
  const outcome = await dispatch(deps, job, {
    system: intakeInstructions,
    messages: [{ role: "user", content: buildUserMessage(command) }],
    thinking: { type: "between_tools" },
    output_config: { effort: "low", format: { type: "json_schema", schema } },
  });
  if (!outcome.ok) return failureResult(outcome);
  const check = checkIntakeReply(outcome.message, command);
  if (!check.ok) {
    deps.log({
      event: "intakeMalformed",
      taskId: job.taskId,
      reason: check.reason,
    });
    return { kind: "failure", failure: "error" };
  }
  return { kind: "intake", outcome: check.outcome };
}
