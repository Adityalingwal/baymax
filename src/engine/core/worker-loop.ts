import type Anthropic from "@anthropic-ai/sdk";
import { dispatch } from "./dispatch";
import type { DispatchDeps, DispatchJob, DispatchOutcome } from "./dispatch";
import { taskLimits } from "./limits";
import { failureKindOf } from "./model-failure";
import type { LoopEnding, ToolTurn } from "./tool-batch";

// The fixed prompt start (system and tools) plus the fields that stay the same on every step of a run.
type WorkerPrompt = {
  system: string;
  tools: Anthropic.Tool[];
  schema: Record<string, unknown>;
  thinking: Anthropic.ThinkingConfigParam;
  effort: Anthropic.OutputConfig["effort"];
};

type LoopOutcome =
  | { kind: "answer"; text: string }
  | { kind: "end"; ending: LoopEnding }
  | { kind: "aborted" };

type WorkerLoop = {
  deps: DispatchDeps;
  job: DispatchJob;
  prompt: WorkerPrompt;
  firstMessage: string;
  runTools: (blocks: Anthropic.ToolUseBlock[]) => Promise<ToolTurn>;
};

const failed = {
  kind: "end",
  ending: { kind: "error", cause: "error" },
} as const;

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

function answerOf(message: Anthropic.Message): LoopOutcome {
  const texts = message.content.filter((block) => block.type === "text");
  if (texts.length !== 1 || texts[0].type !== "text") return failed;
  return { kind: "answer", text: texts[0].text };
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
export async function runWorkerLoop(loop: WorkerLoop): Promise<LoopOutcome> {
  const { deps, job } = loop;
  const history: Anthropic.MessageParam[] = [
    { role: "user", content: loop.firstMessage },
  ];
  for (;;) {
    const outcome = await dispatch(
      deps,
      job,
      stepRequest(loop.prompt, history),
    );
    if (job.signal.aborted) return { kind: "aborted" };
    if (!outcome.ok) return dispatchEnding(outcome);
    const { message } = outcome;
    history.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "end_turn") return answerOf(message);
    if (message.stop_reason !== "tool_use") return failed;
    const turn = await toolTurn(loop, message);
    if (job.signal.aborted || turn.kind === "aborted") {
      return { kind: "aborted" };
    }
    if (turn.kind === "end") return turn;
    history.push({ role: "user", content: turn.results });
  }
}
