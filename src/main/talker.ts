import type {
  ModelFailure,
  TextOutcome,
  TextRequest,
  TextStream,
} from "../providers/anthropic";
import type { TaskId } from "../shared/cards";
import type { FailureKind } from "../shared/engine";
import type { LineFeed } from "./speech";
import type { SaidKind, Timers } from "./tasks/state";
import type { TalkRequest, TalkerReply } from "./tasks/talk";
import {
  givenText,
  questionInstructions,
  replyInstructions,
  replyMessage,
  resultInstructions,
  rewriteMessage,
} from "./talker-prompt";

export type TalkerDeps = {
  stream: TextStream | null; // null when there is no Anthropic key
  talk: (spoken: { taskId: TaskId | null; kind: SaidKind }) => LineFeed;
  onReply: (taskId: TaskId, reply: TalkerReply) => void;
  timers: Timers;
  log: (message: string) => void;
};

type Reply = Extract<TalkRequest, { kind: "reply" }>;
type Rewrite = Exclude<TalkRequest, Reply>;

const talkerModel = "claude-haiku-5-5";
const maxTokens = 256;
const replyTimeoutMs = 10_000;
// A rewrite with no words after about 3 s gives way to the given text, spoken as written.
const rewriteMs = 3000;

const failureKinds: Record<ModelFailure, FailureKind> = {
  keyRejected: "keyRejected",
  noCredit: "noCredit",
  unreachable: "modelsUnreachable",
  aborted: "error",
  error: "error",
};

// Thinking off and low effort: the first words are what the user waits for.
function request(system: string, content: string): TextRequest {
  return {
    model: talkerModel,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content }],
  };
}

// A missing key or a throwing call becomes a failed outcome, so a line is always ended.
async function call(
  deps: TalkerDeps,
  body: TextRequest,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<TextOutcome> {
  if (deps.stream === null) {
    return { ok: false, failure: "keyRejected", detail: "no Anthropic key" };
  }
  try {
    return await deps.stream(
      body,
      { timeoutMs: replyTimeoutMs, signal },
      onText,
    );
  } catch (error) {
    return { ok: false, failure: "error", detail: String(error) };
  }
}

async function reply(deps: TalkerDeps, talk: Reply): Promise<void> {
  const line = deps.talk({ taskId: talk.taskId, kind: "talk" });
  const body = request(replyInstructions, replyMessage(talk));
  const signal = new AbortController().signal;
  const outcome = await call(deps, body, signal, line.push);
  line.end();
  const text = outcome.ok ? outcome.text.trim() : "";
  if (text !== "") return deps.onReply(talk.taskId, { kind: "said", text });
  // A talker failure is only logged: the intake goes on without it.
  deps.log(`talker reply failed: ${outcome.ok ? "no text" : outcome.detail}`);
  const failure = outcome.ok ? "error" : failureKinds[outcome.failure];
  deps.onReply(talk.taskId, { kind: "failed", failure });
}

async function rewrite(deps: TalkerDeps, talk: Rewrite): Promise<void> {
  const kind = talk.kind === "result" ? "answer" : "question";
  const line = deps.talk({ taskId: talk.taskId, kind });
  const abort = new AbortController();
  let started = false;
  const cancelTimer = deps.timers.setTimer(rewriteMs, () => {
    if (!started) abort.abort();
  });
  const system =
    talk.kind === "result" ? resultInstructions : questionInstructions;
  const body = request(system, rewriteMessage(talk));
  const outcome = await call(deps, body, abort.signal, (text) => {
    if (abort.signal.aborted) return;
    started = true;
    line.push(text);
  });
  cancelTimer();
  if (!outcome.ok) deps.log(`talker rewrite failed: ${outcome.detail}`);
  // Once its words have started, a failing rewrite ends where it is; before that, the given text is said.
  if (!started) line.push(givenText(talk));
  line.end();
}

// The talker is Baymax's only voice for model text: its reply to new words, and the clarifying question and the result in its own words.
export function createTalker(deps: TalkerDeps): {
  talk: (request: TalkRequest) => void;
} {
  return {
    talk: (talk) => {
      const run =
        talk.kind === "reply" ? reply(deps, talk) : rewrite(deps, talk);
      run.catch((error: unknown) => {
        deps.log(`talker threw: ${String(error)}`);
      });
    },
  };
}
