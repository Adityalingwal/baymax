import type {
  ModelFailure,
  TextOutcome,
  TextRequest,
  TextStream,
  ToolRound,
} from "../providers/anthropic";
import type { TaskId } from "../shared/cards";
import type { FailureKind } from "../shared/engine";
import type { LineFeed } from "./speech";
import type { SaidKind, Timers } from "./tasks/state";
import { frontKey } from "./tasks/talk";
import type { TalkRequest, TalkerReply } from "./tasks/talk";
import { decideTool, frontInstructions, frontMessages } from "./talker-prompt";

export type TalkerDeps = {
  stream: TextStream | null; // null when there is no Anthropic key
  talk: (spoken: {
    taskId: TaskId | null;
    kind: SaidKind;
    key: string | null;
  }) => LineFeed;
  onReply: (taskId: TaskId, attemptId: string, reply: TalkerReply) => void;
  timers: Timers;
  log: (message: string) => void;
};

type Attempt = {
  abort: AbortController;
  line: LineFeed;
  stopFirstWords: () => void; // the first words came, so only the whole-call deadline is left
  stopDeadline: () => void; // both deadlines
  ended: boolean; // the line was ended (or cut), so nothing more is pushed to it
  spoken: string; // the text pushed to speech so far
};

const talkerModel = "claude-fable-5-1";
// The line, the decide call and any adaptive thinking all count against this.
const maxTokens = 2048;
// Two wall-clock limits from the start of the call, since the SDK's timeout stops counting once headers arrive:
// no words in time is a model that does not answer; a call that has begun may take longer.
const firstWordsMs = 6_000;
const wholeCallMs = 30_000;

const failureKinds: Record<ModelFailure, FailureKind> = {
  keyRejected: "keyRejected",
  noCredit: "noCredit",
  unreachable: "modelsUnreachable",
  aborted: "error",
  error: "error",
};

// Fable rejects disabled thinking and a forced tool, so the thinking and tool_choice fields are left out.
function request(talk: TalkRequest): TextRequest {
  return {
    model: talkerModel,
    max_tokens: maxTokens,
    output_config: { effort: "low" },
    system: frontInstructions,
    tools: [decideTool],
    messages: frontMessages(talk),
  };
}

// A missing key or a throwing call becomes a failed outcome, so a line is always ended.
async function call(
  deps: TalkerDeps,
  body: TextRequest,
  signal: AbortSignal,
  onText: (text: string) => void,
  onToolStart: () => void,
): Promise<TextOutcome> {
  if (deps.stream === null) {
    return { ok: false, failure: "keyRejected", detail: "no Anthropic key" };
  }
  try {
    return await deps.stream(
      body,
      { timeoutMs: wholeCallMs, signal },
      onText,
      onToolStart,
    );
  } catch (error) {
    return { ok: false, failure: "error", detail: String(error) };
  }
}

type Judged = { reply: TalkerReply; detail: string | null }; // detail is set when the call failed

const failedError = (detail: string, text: string): Judged => ({
  reply: { kind: "failed", failure: "error", ...spokenText(text) },
  detail,
});

const spokenText = (text: string) => (text === "" ? {} : { text });

// A routable response is text, then exactly one decide call, stopped at the tool; no tool at all hands main a null decision.
function judge(text: string, round: ToolRound | undefined): Judged {
  if (text === "") return failedError("no text", text);
  if (round === undefined) return failedError("no tool round", text);
  const { toolUses, stopReason } = round;
  if (toolUses.length === 0) {
    if (stopReason !== "end_turn")
      return failedError(`stopped: ${stopReason}`, text);
    return { reply: { kind: "said", text, decision: null }, detail: null };
  }
  if (toolUses.length !== 1 || toolUses[0].name !== "decide") {
    return failedError(
      `tools: ${toolUses.map((tool) => tool.name).join(",")}`,
      text,
    );
  }
  if (stopReason !== "tool_use")
    return failedError(`stopped: ${stopReason}`, text);
  const decision = toolUses[0].input;
  return { reply: { kind: "said", text, decision }, detail: null };
}

function usageNote(round: ToolRound | undefined): string {
  if (round === undefined) return "";
  const { usage } = round;
  const cache = usage.cacheReadInputTokens ?? "none";
  return ` (in ${usage.inputTokens}, out ${usage.outputTokens}, cache read ${cache})`;
}

function endLine(attempt: Attempt): void {
  if (attempt.ended) return;
  attempt.ended = true;
  attempt.line.end();
}

type Outcome = { outcome: TextOutcome; timedOut: boolean };

async function runCall(
  deps: TalkerDeps,
  talk: TalkRequest,
  attempt: Attempt,
  alive: () => boolean,
): Promise<Outcome> {
  let timedOut = false;
  const deadline = new Promise<TextOutcome>((resolve) => {
    const expire = (detail: string) => () => {
      attempt.stopDeadline();
      timedOut = true;
      attempt.abort.abort();
      resolve({ ok: false, failure: "unreachable", detail });
    };
    const stopFirst = deps.timers.setTimer(
      firstWordsMs,
      expire("no first words in 6 s"),
    );
    const stopWhole = deps.timers.setTimer(
      wholeCallMs,
      expire("no finish in 30 s"),
    );
    attempt.stopFirstWords = stopFirst;
    attempt.stopDeadline = () => {
      stopFirst();
      stopWhole();
    };
  });
  const answered = call(
    deps,
    request(talk),
    attempt.abort.signal,
    (text) => {
      if (!alive() || attempt.ended) return;
      if (text.trim() !== "") attempt.stopFirstWords();
      attempt.spoken += text;
      attempt.line.push(text);
    },
    () => endLine(attempt),
  );
  const outcome = await Promise.race([answered, deadline]);
  return { outcome, timedOut };
}

async function front(
  deps: TalkerDeps,
  attempts: Map<string, Attempt>,
  talk: TalkRequest,
): Promise<void> {
  const line = deps.talk({
    taskId: talk.taskId,
    kind: "talk",
    key: frontKey(talk),
  });
  const attempt: Attempt = {
    abort: new AbortController(),
    line,
    stopFirstWords: () => undefined,
    stopDeadline: () => undefined,
    ended: false,
    spoken: "",
  };
  attempts.set(talk.attemptId, attempt);
  const alive = () => attempts.get(talk.attemptId) === attempt;
  const { outcome, timedOut } = await runCall(deps, talk, attempt, alive);
  // A cancelled, replaced or closed attempt has been removed and its speech cut: it reports nothing.
  if (!alive()) return;
  attempts.delete(talk.attemptId);
  attempt.stopDeadline();
  if (!timedOut) endLine(attempt);
  else if (!attempt.ended) {
    // A line that already ended is left alone; one still open is cut.
    attempt.ended = true;
    line.cut();
  }
  const judged = outcome.ok
    ? judge(outcome.text.trim(), outcome.round)
    : {
        reply: failedReply(outcome, attempt.spoken.trim()),
        detail: outcome.detail,
      };
  const note = outcome.ok ? usageNote(outcome.round) : "";
  if (judged.detail === null) deps.log(`talker front call done${note}`);
  else deps.log(`talker front call failed: ${judged.detail}`);
  deps.onReply(talk.taskId, talk.attemptId, judged.reply);
}

function failedReply(
  outcome: Extract<TextOutcome, { ok: false }>,
  text: string,
): TalkerReply {
  return {
    kind: "failed",
    failure: failureKinds[outcome.failure],
    ...spokenText(text),
  };
}

function cancel(attempts: Map<string, Attempt>, attemptId: string): void {
  const attempt = attempts.get(attemptId);
  if (attempt === undefined) return;
  attempts.delete(attemptId);
  attempt.stopDeadline();
  attempt.abort.abort();
  attempt.ended = true;
  attempt.line.cut();
}

// The front call is Baymax's only model voice: a spoken line, then the decision about the words.
export function createTalker(deps: TalkerDeps): {
  talk: (request: TalkRequest) => void;
  cancel: (attemptId: string) => void;
  shutdown: () => void;
} {
  const attempts = new Map<string, Attempt>();
  return {
    talk: (talk) => {
      front(deps, attempts, talk).catch((error: unknown) => {
        deps.log(`talker threw: ${String(error)}`);
      });
    },
    cancel: (attemptId) => cancel(attempts, attemptId),
    shutdown: () => {
      for (const attemptId of [...attempts.keys()]) cancel(attempts, attemptId);
    },
  };
}
