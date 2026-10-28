import type Anthropic from "@anthropic-ai/sdk";
import { messageOf } from "./dev-log";
import { dispatch } from "./dispatch";
import type { DispatchDeps, DispatchJob } from "./dispatch";

// The judge's three checks, each in the plain words the worker and the unchecked ending use.
export const judgeFlags = {
  goalMet: "whether the answer meets the goal",
  claimsBacked: "whether the claims are backed by the read pages",
  spokenLineBacked: "whether the spoken line is backed by the card",
} as const;

export type JudgeFlag = keyof typeof judgeFlags;

// failed names the false flags, for the dev log; gaps are the judge's trimmed, non-empty phrases.
export type JudgeOutcome =
  | { kind: "pass" }
  | {
      kind: "fail";
      uncheckedPart: string;
      failed: string;
      flags: JudgeFlag[];
      gaps: string[];
    }
  | { kind: "broken"; reason: string } // the judge itself failed, so nothing is checked
  | { kind: "limitHit" }
  | { kind: "aborted" };

const flagNames = Object.keys(judgeFlags) as JudgeFlag[];

const verdictSchema = {
  type: "object",
  properties: {
    goalMet: { type: "boolean" },
    claimsBacked: { type: "boolean" },
    spokenLineBacked: { type: "boolean" },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: [...flagNames, "gaps"],
  additionalProperties: false,
};

type Verdict = Record<JudgeFlag, boolean> & { gaps: string[] };

function verdictFrom(value: unknown): Verdict | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const fields = value as Record<string, unknown>;
  const { gaps } = fields;
  const shaped =
    keys.length === flagNames.length + 1 &&
    flagNames.every((flag) => typeof fields[flag] === "boolean") &&
    Array.isArray(gaps) &&
    gaps.every((gap) => typeof gap === "string");
  return shaped ? (value as Verdict) : null;
}

function readVerdict(message: Anthropic.Message): Verdict | null {
  if (message.stop_reason !== "end_turn") return null;
  const texts = message.content.filter((block) => block.type === "text");
  if (texts.length !== 1 || texts[0].type !== "text") return null;
  try {
    return verdictFrom(JSON.parse(texts[0].text));
  } catch {
    return null;
  }
}

function outcomeOf(verdict: Verdict): JudgeOutcome {
  const falseFlags = flagNames.filter((flag) => !verdict[flag]);
  if (falseFlags.length === 0) return { kind: "pass" };
  const gaps = verdict.gaps.map((gap) => gap.trim()).filter((gap) => gap);
  const fallback = falseFlags.map((flag) => judgeFlags[flag]).join("; ");
  return {
    kind: "fail",
    uncheckedPart: gaps.length === 0 ? fallback : gaps.join("; "),
    failed: falseFlags.join(","),
    flags: falseFlags,
    gaps,
  };
}

async function askJudge(
  deps: DispatchDeps,
  job: DispatchJob,
  prompt: { system: string; user: string },
): Promise<JudgeOutcome> {
  const outcome = await dispatch(deps, job, {
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    thinking: { type: "between_tools" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: verdictSchema },
    },
  });
  if (job.signal.aborted) return { kind: "aborted" };
  if (!outcome.ok) {
    if (outcome.reason === "limitHit") return { kind: "limitHit" };
    return outcome.failure === "aborted"
      ? { kind: "aborted" }
      : { kind: "broken", reason: outcome.failure };
  }
  const verdict = readVerdict(outcome.message);
  return verdict === null
    ? { kind: "broken", reason: "malformed" }
    : outcomeOf(verdict);
}

// Checks support and completion, not truth; any failure of the judge itself leaves the answer unchecked.
export async function runJudge(
  deps: DispatchDeps,
  job: DispatchJob,
  prompt: { system: string; user: string },
): Promise<JudgeOutcome> {
  try {
    return await askJudge(deps, job, prompt);
  } catch (error) {
    if (job.signal.aborted) return { kind: "aborted" };
    deps.log({
      event: "judgeError",
      taskId: job.taskId,
      message: messageOf(error),
    });
    return { kind: "broken", reason: "thrown" };
  }
}
