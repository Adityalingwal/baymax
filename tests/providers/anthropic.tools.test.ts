import { afterEach, describe, expect, it } from "vitest";
import { createTextStream } from "../../src/providers/anthropic";
import type { TextRequest } from "../../src/providers/anthropic";
import type { Respond } from "./anthropic.harness";
import { localFetch, request, startServer } from "./anthropic.harness";

type ToolBlock = { tool: string; json: string[]; id?: string };
type Block = { text: string[] } | ToolBlock;

const start = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-fable-5-1",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 30 },
  },
};

function textEvents(index: number, texts: string[]): object[] {
  const open = {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  };
  const deltas = texts.map((text) => ({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  }));
  return [open, ...deltas];
}

function toolEvents(index: number, block: ToolBlock): object[] {
  const open = {
    type: "content_block_start",
    index,
    content_block: {
      type: "tool_use",
      id: block.id ?? `toolu_${index}`,
      name: block.tool,
      input: {},
    },
  };
  const deltas = block.json.map((partial_json) => ({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  }));
  return [open, ...deltas];
}

function eventsFor(blocks: Block[], stopReason: string) {
  const events: object[] = [start];
  blocks.forEach((block, index) => {
    const opened =
      "text" in block
        ? textEvents(index, block.text)
        : toolEvents(index, block);
    events.push(...opened, { type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 9 },
    },
    { type: "message_stop" },
  );
  return events;
}

const respondWith =
  (events: object[]): Respond =>
  (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) {
      const { type } = event as { type: string };
      response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  };

const decide = (...json: string[]): Block => ({ tool: "decide", json });
const whole = decide('{"route":"chat","topic":null}');
const hi: Block = { text: ["Hi ", "there."] };

type Row = {
  name: string;
  blocks: Block[];
  stopReason: string;
  spoken: string[];
  toolStarts: number;
  text: string;
  tools: { name: string; input: unknown }[];
};

const rows: Row[] = [
  {
    name: "text, then one decide tool whose JSON arrives split across events",
    blocks: [hi, decide('{"route":"ch', 'at","top', 'ic":null}')],
    stopReason: "tool_use",
    spoken: ["Hi ", "there."],
    toolStarts: 1,
    text: "Hi there.",
    tools: [{ name: "decide", input: { route: "chat", topic: null } }],
  },
  {
    name: "text after the tool block starts is not passed on and not returned",
    blocks: [hi, whole, { text: ["Anything else?"] }],
    stopReason: "tool_use",
    spoken: ["Hi ", "there."],
    toolStarts: 1,
    text: "Hi there.",
    tools: [{ name: "decide", input: { route: "chat", topic: null } }],
  },
  {
    name: "no tool block",
    blocks: [hi],
    stopReason: "end_turn",
    spoken: ["Hi ", "there."],
    toolStarts: 0,
    text: "Hi there.",
    tools: [],
  },
  {
    name: "two tool blocks",
    blocks: [hi, whole, whole],
    stopReason: "tool_use",
    spoken: ["Hi ", "there."],
    toolStarts: 1,
    text: "Hi there.",
    tools: [
      { name: "decide", input: { route: "chat", topic: null } },
      { name: "decide", input: { route: "chat", topic: null } },
    ],
  },
  {
    name: "another tool name",
    blocks: [hi, { tool: "search", json: ['{"q":"x"}'] }],
    stopReason: "tool_use",
    spoken: ["Hi ", "there."],
    toolStarts: 1,
    text: "Hi there.",
    tools: [{ name: "search", input: { q: "x" } }],
  },
  {
    name: "a tool and no text",
    blocks: [whole],
    stopReason: "tool_use",
    spoken: [],
    toolStarts: 1,
    text: "",
    tools: [{ name: "decide", input: { route: "chat", topic: null } }],
  },
  {
    name: "a stream cut at max_tokens",
    blocks: [hi, decide('{"route":"chat","topic":"unfinished')],
    stopReason: "max_tokens",
    spoken: ["Hi ", "there."],
    toolStarts: 1,
    text: "Hi there.",
    tools: [{ name: "decide", input: expect.anything() }],
  },
  {
    name: "a refusal",
    blocks: [{ text: ["I can't help with that."] }],
    stopReason: "refusal",
    spoken: ["I can't help with that."],
    toolStarts: 0,
    text: "I can't help with that.",
    tools: [],
  },
];

const withTools: TextRequest = {
  ...request,
  tools: [
    {
      name: "decide",
      description: "x",
      input_schema: { type: "object", properties: {} },
    },
  ],
};

let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
});

async function streamFrom(respond: Respond, body: TextRequest) {
  const server = await startServer(respond);
  stops.push(server.stop);
  const stream = createTextStream({
    apiKey: "test-key",
    fetch: localFetch(server.port),
  });
  const spoken: string[] = [];
  let toolStarts = 0;
  const outcome = await stream(
    body,
    { timeoutMs: 5000, signal: new AbortController().signal },
    (text) => spoken.push(text),
    () => (toolStarts += 1),
  );
  return { outcome, spoken, toolStarts, seen: server.seen };
}

describe("the streaming call with a tool", () => {
  it.each(rows)(
    "$name",
    async ({ blocks, stopReason, spoken, toolStarts, text, tools }) => {
      const result = await streamFrom(
        respondWith(eventsFor(blocks, stopReason)),
        withTools,
      );
      expect(result.spoken).toEqual(spoken);
      expect(result.toolStarts).toBe(toolStarts);
      expect(result.outcome).toEqual({
        ok: true,
        text,
        round: {
          stopReason,
          toolUses: tools,
          usage: {
            inputTokens: 40,
            outputTokens: 9,
            cacheReadInputTokens: 30,
          },
        },
      });
    },
  );

  it("sends the tools and leaves a request without tools as it was", async () => {
    const plain = await streamFrom(
      respondWith(eventsFor([hi], "end_turn")),
      request,
    );
    expect(plain.outcome).toEqual({ ok: true, text: "Hi there." });
    expect(plain.toolStarts).toBe(0);
    const tooled = await streamFrom(
      respondWith(eventsFor([hi, whole], "tool_use")),
      withTools,
    );
    expect(JSON.parse(tooled.seen[0].body)).toMatchObject({
      tools: [{ name: "decide" }],
    });
  });
});
