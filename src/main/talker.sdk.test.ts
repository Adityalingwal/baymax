import { afterEach, describe, expect, it } from "vitest";
import { createTextStream } from "../providers/anthropic";
import { localFetch, startServer } from "../providers/anthropic.harness";
import type { Respond } from "../providers/anthropic.harness";
import type { TalkerReply } from "./tasks/talk";
import { createTalker } from "./talker";
import { frontRequest } from "./talker.harness";
import { createClock } from "./tasks/harness";

const events = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-fable-5-1",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "I'll check" },
  },
];

// Sends headers and the first words, then never finishes the body.
const stalled: Respond = (_request, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
};

let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
});

async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !done(); turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!done()) throw new Error("timed out");
}

describe("the 10 s deadline through the SDK", () => {
  it("aborts a response that sent headers and words and then stalled, cuts the speech and reports once", async () => {
    const server = await startServer(stalled);
    stops.push(server.stop);
    const clock = createClock();
    const parts: string[] = [];
    const replies: TalkerReply[] = [];
    const talker = createTalker({
      stream: createTextStream({
        apiKey: "test-key",
        fetch: localFetch(server.port),
      }),
      talk: () => ({
        push: (text) => parts.push(text),
        end: () => parts.push("<end>"),
        cut: () => parts.push("<cut>"),
      }),
      onReply: (_taskId, _attemptId, reply) => replies.push(reply),
      timers: { setTimer: clock.setTimer },
      log: () => undefined,
    });
    talker.talk(frontRequest());
    await until(() => parts.length > 0);
    clock.advance(10_000);
    await until(() => replies.length > 0);
    expect(parts).toEqual(["I'll check", "<cut>"]);
    expect(replies).toEqual([
      { kind: "failed", failure: "modelsUnreachable", text: "I'll check" },
    ]);
  });
});
