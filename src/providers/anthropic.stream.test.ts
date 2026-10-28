import { afterEach, describe, expect, it } from "vitest";
import { createTextStream } from "./anthropic";
import type { Respond } from "./anthropic.harness";
import { localFetch, request, startServer } from "./anthropic.harness";

const events = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
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
  ...["Hi ", "there."].map((text) => ({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  })),
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  },
  { type: "message_stop" },
];

const streamed: Respond = (_request, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
};

const rejected: Respond = (_request, response) => {
  response.writeHead(401, { "content-type": "application/json" });
  const error = { type: "authentication_error", message: "nope" };
  response.end(JSON.stringify({ type: "error", error }));
};

let stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(stops.map((stop) => stop()));
  stops = [];
});

async function streamFrom(
  respond: Respond,
  signal = new AbortController().signal,
) {
  const server = await startServer(respond);
  stops.push(server.stop);
  const stream = createTextStream({
    apiKey: "test-key",
    fetch: localFetch(server.port),
  });
  const pieces: string[] = [];
  const outcome = await stream(request, { timeoutMs: 5000, signal }, (text) =>
    pieces.push(text),
  );
  return { outcome, pieces, seen: server.seen };
}

describe("the streaming text call", () => {
  it("passes each text piece on as it arrives and returns the whole text", async () => {
    const { outcome, pieces, seen } = await streamFrom(streamed);
    expect(pieces).toEqual(["Hi ", "there."]);
    expect(outcome).toEqual({ ok: true, text: "Hi there." });
    expect(JSON.parse(seen[0].body)).toMatchObject({ stream: true });
  });

  it("maps a rejected key to keyRejected", async () => {
    const { outcome, pieces } = await streamFrom(rejected);
    expect(pieces).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, failure: "keyRejected" });
  });

  it("reports an aborted call as aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const { outcome } = await streamFrom(streamed, abort.signal);
    expect(outcome).toMatchObject({ ok: false, failure: "aborted" });
  });
});
