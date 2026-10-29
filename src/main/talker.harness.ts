import type {
  TextOutcome,
  TextRequest,
  TextStream,
} from "../providers/anthropic";
import type { TaskId } from "../shared/cards";
import { createTalker } from "./talker";
import { createClock } from "./tasks/harness";
import type { TalkRequest, TalkerReply } from "./tasks/talk";

type Call = {
  request: TextRequest;
  signal: AbortSignal;
  onText: (text: string) => void;
  onToolStart: () => void;
  resolve: (outcome: TextOutcome) => void;
};

// The talker with its model call, its speech lines and its timer faked; a line is shown as its pushes and its end.
// With ignoreAbort the fake call records its signal but stays pending until a test settles it, as a provider that finishes late would.
export function createHarness(
  options: { noKey?: boolean; ignoreAbort?: boolean } = {},
) {
  const calls: Call[] = [];
  const lines: { taskId: TaskId | null; kind: string; parts: string[] }[] = [];
  const replies: { taskId: TaskId; attemptId: string; reply: TalkerReply }[] =
    [];
  const logs: string[] = [];
  const clock = createClock();
  const stream: TextStream = (request, streamOptions, onText, onToolStart) =>
    new Promise<TextOutcome>((resolve) => {
      calls.push({
        request,
        signal: streamOptions.signal,
        onText,
        onToolStart: onToolStart ?? (() => undefined),
        resolve,
      });
      // The real call ends as aborted when its signal fires.
      if (options.ignoreAbort === true) return;
      streamOptions.signal.addEventListener("abort", () =>
        resolve({ ok: false, failure: "aborted", detail: "aborted" }),
      );
    });
  const talker = createTalker({
    stream: options.noKey === true ? null : stream,
    talk: ({ taskId, kind }) => {
      const line = { taskId, kind, parts: [] as string[] };
      lines.push(line);
      return {
        push: (text) => line.parts.push(text),
        end: () => line.parts.push("<end>"),
        cut: () => line.parts.push("<cut>"),
      };
    },
    onReply: (taskId, attemptId, reply) =>
      replies.push({ taskId, attemptId, reply }),
    timers: { setTimer: clock.setTimer },
    log: (message) => logs.push(message),
  });
  return {
    talker,
    calls,
    lines,
    replies,
    logs,
    advance: clock.advance,
    pendingTimers: clock.pending,
  };
}

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function lastUserText(request: TextRequest): string {
  const content = request.messages.at(-1)?.content;
  return typeof content === "string" ? content : "";
}

export const frontRequest = (
  fields: Partial<TalkRequest> = {},
): TalkRequest => ({
  kind: "front",
  attemptId: "t2#1",
  taskId: "t2",
  utteranceId: null,
  words: "will it rain in Delhi tomorrow?",
  history: [],
  recent: [],
  tasks: [],
  waiting: null,
  ...fields,
});

// A finished stream: the spoken text and the tool blocks it ended with.
export function finished(
  text: string,
  tools: { name: string; input: unknown }[],
  stopReason = "tool_use",
): TextOutcome {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 7 };
  return { ok: true, text, round: { stopReason, toolUses: tools, usage } };
}
