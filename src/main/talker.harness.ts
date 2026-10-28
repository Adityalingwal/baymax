import type {
  TextOutcome,
  TextRequest,
  TextStream,
} from "../providers/anthropic";
import type { TaskId } from "../shared/cards";
import { createTalker } from "./talker";
import { createClock } from "./tasks/harness";
import type { TalkerReply } from "./tasks/talk";

type Call = {
  request: TextRequest;
  signal: AbortSignal;
  onText: (text: string) => void;
  resolve: (outcome: TextOutcome) => void;
};

// The talker with its model call, its speech lines and its timer faked; a line is shown as its pushes and its end.
export function createHarness(options: { noKey?: boolean } = {}) {
  const calls: Call[] = [];
  const lines: { taskId: TaskId | null; kind: string; parts: string[] }[] = [];
  const replies: { taskId: TaskId; reply: TalkerReply }[] = [];
  const logs: string[] = [];
  const clock = createClock();
  const stream: TextStream = (request, options, onText) =>
    new Promise<TextOutcome>((resolve) =>
      calls.push({ request, signal: options.signal, onText, resolve }),
    );
  const talker = createTalker({
    stream: options.noKey === true ? null : stream,
    talk: ({ taskId, kind }) => {
      const line = { taskId, kind, parts: [] as string[] };
      lines.push(line);
      return {
        push: (text) => line.parts.push(text),
        end: () => line.parts.push("<end>"),
      };
    },
    onReply: (taskId, reply) => replies.push({ taskId, reply }),
    timers: { setTimer: clock.setTimer },
    log: (message) => logs.push(message),
  });
  return { talker, calls, lines, replies, logs, advance: clock.advance };
}

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function userText(request: TextRequest): string {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : "";
}
