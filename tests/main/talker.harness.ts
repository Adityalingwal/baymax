import type {
  TextOutcome,
  TextRequest,
  TextStream,
} from "../../src/providers/anthropic";
import type { TaskId } from "../../src/shared/cards";
import { createTalker } from "../../src/main/talker";
import { createClock } from "./tasks/harness";
import type { TalkRequest, TalkerReply } from "../../src/main/tasks/talk";

type Call = {
  request: TextRequest;
  signal: AbortSignal;
  onText: (text: string) => void;
  onToolStart: () => void;
  resolve: (outcome: TextOutcome) => void;
  settled: boolean; // a test resolved it
  aborted: boolean;
};

// The front call's model faked: each call waits until a test streams its text and settles it.
// With ignoreAbort the call records its signal but stays pending, as a provider that finishes late would.
export function fakeStream(ignoreAbort = false) {
  const calls: Call[] = [];
  const stream: TextStream = (request, options, onText, onToolStart) =>
    new Promise<TextOutcome>((resolve) => {
      const call: Call = {
        request,
        signal: options.signal,
        onText,
        onToolStart: onToolStart ?? (() => undefined),
        resolve: (outcome) => {
          call.settled = true;
          resolve(outcome);
        },
        settled: false,
        aborted: false,
      };
      calls.push(call);
      options.signal.addEventListener("abort", () => {
        call.aborted = true;
        // The real call ends as aborted when its signal fires.
        if (!ignoreAbort)
          resolve({ ok: false, failure: "aborted", detail: "aborted" });
      });
    });
  return { calls, stream };
}

// The talker with its model call, its speech lines and its timer faked; a line is shown as its pushes and its end.
export function createHarness(
  options: { noKey?: boolean; ignoreAbort?: boolean } = {},
) {
  const { calls, stream } = fakeStream(options.ignoreAbort === true);
  const lines: { taskId: TaskId | null; kind: string; parts: string[] }[] = [];
  const replies: { taskId: TaskId; attemptId: string; reply: TalkerReply }[] =
    [];
  const logs: string[] = [];
  const clock = createClock();
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
