import type Anthropic from "@anthropic-ai/sdk";
import type { ModelFailure } from "../../providers/anthropic";
import type { FailureKind } from "../../shared/engine";
import { dispatch } from "./dispatch";
import type { DispatchDeps, DispatchJob, DispatchOutcome } from "./dispatch";
import { taskLimits } from "./limits";
import type { LoopEnding, ToolTurn } from "./tool-batch";

// The fixed prompt start (system and tools) plus the fields that stay the same on every step of a run.
export type WorkerPrompt = {
  system: string;
  tools: Anthropic.Tool[];
  schema: Record<string, unknown>;
  thinking: Anthropic.ThinkingConfigParam;
  effort: Anthropic.OutputConfig["effort"];
};

// An answer turn ends the round; "cutOff" is one stopped at the output ceiling, whose text is not whole; "malformed" has no single text to read.
type LoopOutcome =
  | { kind: "answer"; text: string }
  | { kind: "cutOff" }
  | { kind: "malformed" }
  | { kind: "end"; ending: LoopEnding }
  | { kind: "aborted" };

type WorkerLoop = {
  deps: DispatchDeps;
  job: DispatchJob;
  prompt: WorkerPrompt;
  runTools: (blocks: Anthropic.ToolUseBlock[]) => Promise<ToolTurn>;
};

const failed = {
  kind: "end",
  ending: { kind: "error", cause: "error" },
} as const;

// What the user is told for a failed model call; null for a cancelled call, which says nothing.
function failureKindOf(failure: ModelFailure): FailureKind | null {
  switch (failure) {
    case "aborted":
      return null;
    case "keyRejected":
      return "keyRejected";
    case "noCredit":
      return "noCredit";
    case "unreachable":
      return "modelsUnreachable";
    case "error":
      return "error";
  }
}

function dispatchEnding(
  outcome: Exclude<DispatchOutcome, { ok: true }>,
): LoopOutcome {
  if (outcome.reason === "limitHit") {
    return { kind: "end", ending: { kind: "limitHit" } };
  }
  const cause = failureKindOf(outcome.failure);
  return cause === null
    ? { kind: "aborted" }
    : { kind: "end", ending: { kind: "error", cause } };
}

// A cut-off tool call cannot be followed by plain text, so it ends the run instead of a retry.
function answerOf(message: Anthropic.Message): LoopOutcome {
  if (message.stop_reason === "max_tokens") {
    const calls = message.content.some((block) => block.type === "tool_use");
    return calls ? failed : { kind: "cutOff" };
  }
  const texts = message.content.filter((block) => block.type === "text");
  if (texts.length !== 1 || texts[0].type !== "text") {
    return { kind: "malformed" };
  }
  return { kind: "answer", text: texts[0].text };
}

// The API refuses a resent assistant turn with no content, and a rewrite may follow this turn.
function canResend(message: Anthropic.Message): boolean {
  return message.content.some(
    (block) =>
      block.type === "tool_use" ||
      (block.type === "text" && block.text.trim() !== ""),
  );
}

// A fresh request object and messages array each step; earlier turns are never edited, so the cached prefix holds.
function stepRequest(prompt: WorkerPrompt, history: Anthropic.MessageParam[]) {
  return {
    cache_control: { type: "ephemeral" as const },
    system: prompt.system,
    tools: prompt.tools,
    thinking: prompt.thinking,
    output_config: {
      effort: prompt.effort,
      format: { type: "json_schema" as const, schema: prompt.schema },
    },
    messages: [...history],
  };
}

// Active time counts each batch's wall time once, however many tools ran in it.
async function toolTurn(
  loop: WorkerLoop,
  message: Anthropic.Message,
): Promise<ToolTurn> {
  const blocks = message.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (blocks.length === 0) return failed;
  const { budget } = loop.job;
  if (budget.activeMs >= taskLimits.activeMs) {
    return { kind: "end", ending: { kind: "limitHit" } };
  }
  const started = loop.deps.now();
  const turn = await loop.runTools(blocks);
  budget.activeMs += loop.deps.now() - started;
  return turn;
}

// Ends only by an answer, an ending or abort; dispatch's model-call limit bounds the steps.
// It only appends to the caller's history, so a later round goes on in the same conversation.
export async function runWorkerLoop(
  loop: WorkerLoop,
  history: Anthropic.MessageParam[],
): Promise<LoopOutcome> {
  const { deps, job } = loop;
  for (;;) {
    const outcome = await dispatch(
      deps,
      job,
      stepRequest(loop.prompt, history),
    );
    if (job.signal.aborted) return { kind: "aborted" };
    if (!outcome.ok) return dispatchEnding(outcome);
    const { message } = outcome;
    if (canResend(message)) {
      history.push({ role: "assistant", content: message.content });
    }
    const { stop_reason: stop } = message;
    if (stop === "end_turn" || stop === "max_tokens") return answerOf(message);
    if (message.stop_reason !== "tool_use") return failed;
    const turn = await toolTurn(loop, message);
    if (job.signal.aborted || turn.kind === "aborted") {
      return { kind: "aborted" };
    }
    if (turn.kind === "end") return turn;
    history.push({ role: "user", content: turn.results });
  }
}
