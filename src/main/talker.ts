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
import { replyKey } from "./tasks/talk";
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
  talk: (spoken: {
    taskId: TaskId | null;
    kind: SaidKind;
    key: string | null;
  }) => LineFeed;
  onReply: (taskId: TaskId, reply: TalkerReply) => void;
  timers: Timers;
  log: (message: string) => void;
};

type Reply = Extract<TalkRequest, { kind: "reply" }>;
type Rewrite = Exclude<TalkRequest, Reply>;

const talkerModel = "claude-fable-5-1";
// Adaptive thinking counts against the ceiling, so it leaves room beyond the short spoken line.
const maxTokens = 1024;
const replyTimeoutMs = 10_000;
// A rewrite with no words after about 3 s, or not finished after about 6 s, gives way to the given text.
const firstWordsMs = 3000;
const rewriteTotalMs = 6000;

const failureKinds: Record<ModelFailure, FailureKind> = {
  keyRejected: "keyRejected",
  noCredit: "noCredit",
  unreachable: "modelsUnreachable",
  aborted: "error",
  error: "error",
};

// Fable rejects disabled thinking, so the thinking field is left out; at low effort it measured about 0.75 s to the first words.
function request(system: string, content: string): TextRequest {
  return {
    model: talkerModel,
    max_tokens: maxTokens,
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
  const key = replyKey(talk);
  const line = deps.talk({ taskId: talk.taskId, kind: "talk", key });
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

// Resolves when a rewrite runs out of time: no words by 3 s, or not finished by 6 s; the call is aborted.
function rewriteDeadline(
  deps: TalkerDeps,
  abort: AbortController,
  started: () => boolean,
): { passed: Promise<TextOutcome>; cancel: () => void } {
  const cancels: (() => void)[] = [];
  const passed = new Promise<TextOutcome>((resolve) => {
    const stop = (detail: string) => {
      abort.abort();
      resolve({ ok: false, failure: "aborted", detail });
    };
    cancels.push(
      deps.timers.setTimer(firstWordsMs, () => {
        if (!started()) stop("no words within 3 s");
      }),
      deps.timers.setTimer(rewriteTotalMs, () => stop("not done within 6 s")),
    );
  });
  return { passed, cancel: () => cancels.forEach((cancel) => cancel()) };
}

async function rewrite(deps: TalkerDeps, talk: Rewrite): Promise<void> {
  const kind: SaidKind = talk.kind === "result" ? "answer" : "question";
  const spoken = { taskId: talk.taskId, kind };
  const line = deps.talk({ ...spoken, key: null });
  const abort = new AbortController();
  let started = false;
  const deadline = rewriteDeadline(deps, abort, () => started);
  const system =
    talk.kind === "result" ? resultInstructions : questionInstructions;
  const body = request(system, rewriteMessage(talk));
  const answered = call(deps, body, abort.signal, (text) => {
    if (abort.signal.aborted) return;
    started = true;
    line.push(text);
  });
  const outcome = await Promise.race([answered, deadline.passed]);
  deadline.cancel();
  abort.abort();
  if (outcome.ok && started) return line.end();
  if (!outcome.ok) deps.log(`talker rewrite failed: ${outcome.detail}`);
  // A failed or stalled rewrite gives way to the given text, whole, so no choice or number is lost;
  // words already spoken are stopped first and the text comes as a fresh line.
  const given = started ? deps.talk({ ...spoken, key: null }) : line;
  if (started) line.cut();
  given.push(givenText(talk));
  given.end();
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
