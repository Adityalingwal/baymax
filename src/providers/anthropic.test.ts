import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createModelCall } from "./anthropic";
import type { ModelFailure, ModelOutcome } from "./anthropic";

type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };
type Respond = (request: IncomingMessage, response: ServerResponse) => void;

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "hello", citations: null }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

const json = (status: number, body: unknown): Respond => {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
};

const apiError = (status: number, type: string, text = "nope"): Respond =>
  json(status, { type: "error", error: { type, message: text } });

const silent: Respond = () => undefined;

const headersOnly: Respond = (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.write('{"id":');
};

const startServer = async (respond: Respond) => {
  const seen: Seen[] = [];
  let markSeen: () => void = () => undefined;
  const firstSeen = new Promise<void>((resolve) => (markSeen = resolve));
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", headers: request.headers, body });
      markSeen();
      respond(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, seen, firstSeen, stop };
};

const localFetch = (port: number): typeof fetch => {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    url.protocol = "http:";
    url.host = `127.0.0.1:${port}`;
    return fetch(url, init);
  };
};

const request = {
  model: "claude-sonnet-5-5",
  max_tokens: 16,
  messages: [{ role: "user" as const, content: "hi" }],
};

const destroySocket: Respond = (request) => request.socket.destroy();

const destroyMidBody: Respond = (request, response) => {
  headersOnly(request, response);
  setTimeout(() => request.socket.destroy(), 50);
};

type Row = {
  name: string;
  respond: Respond;
  expected: "ok" | ModelFailure;
  requests: number;
  timeoutMs?: number;
  deadlineMs?: number;
  closedPort?: boolean;
  abort?: boolean;
  maxMs?: number;
};

const rows: Row[] = [
  {
    name: "a valid message",
    respond: json(200, message),
    expected: "ok",
    requests: 1,
  },
  {
    name: "401",
    respond: apiError(401, "authentication_error"),
    expected: "keyRejected",
    requests: 1,
  },
  {
    name: "403",
    respond: apiError(403, "permission_error"),
    expected: "keyRejected",
    requests: 1,
  },
  {
    name: "402 billing",
    respond: apiError(402, "billing_error"),
    expected: "noCredit",
    requests: 1,
  },
  {
    name: "400 invalid request",
    respond: apiError(400, "invalid_request_error"),
    expected: "error",
    requests: 1,
  },
  {
    name: "429 is retried once",
    respond: apiError(429, "rate_limit_error"),
    expected: "unreachable",
    requests: 2,
  },
  {
    name: "500 is retried once",
    respond: apiError(500, "api_error"),
    expected: "unreachable",
    requests: 2,
  },
  {
    name: "529 is retried once",
    respond: apiError(529, "overloaded_error"),
    expected: "unreachable",
    requests: 2,
  },
  {
    name: "socket destroyed on request",
    respond: destroySocket,
    expected: "unreachable",
    requests: 2,
  },
  {
    name: "never answers, timeout resent",
    respond: silent,
    timeoutMs: 300,
    expected: "unreachable",
    requests: 2,
  },
  {
    name: "closed port",
    respond: silent,
    closedPort: true,
    expected: "unreachable",
    requests: 0,
  },
  {
    name: "caller aborts mid-request",
    respond: silent,
    abort: true,
    expected: "aborted",
    requests: 1,
  },
  {
    name: "body never ends, deadline fires",
    respond: headersOnly,
    timeoutMs: 300,
    deadlineMs: 1_000,
    expected: "unreachable",
    requests: 1,
    maxMs: 1_500,
  },
  {
    name: "socket destroyed mid-body, not retried",
    respond: destroyMidBody,
    expected: "unreachable",
    requests: 1,
  },
  {
    name: "400 message carrying the key",
    respond: apiError(400, "invalid_request_error", "bad key test-key"),
    expected: "error",
    requests: 1,
  },
];

const runRow = async (row: Row) => {
  const server = await startServer(row.respond);
  if (row.closedPort) await server.stop();
  const call = createModelCall({
    apiKey: "test-key",
    fetch: localFetch(server.port),
  });
  const controller = new AbortController();
  if (row.abort) {
    server.firstSeen.then(
      () => controller.abort(),
      () => undefined,
    );
  }
  const started = performance.now();
  const outcome = await call(request, {
    timeoutMs: row.timeoutMs ?? 5_000,
    deadlineMs: row.deadlineMs ?? 8_000,
    signal: controller.signal,
  });
  const ms = performance.now() - started;
  if (!row.closedPort) await server.stop();
  return { outcome, ms, seen: server.seen };
};

const outcomeName = (outcome: ModelOutcome) =>
  outcome.ok ? "ok" : outcome.failure;

describe("createModelCall", () => {
  it.each(rows)(
    "$name",
    async (row) => {
      const { outcome, ms, seen } = await runRow(row);
      expect(outcomeName(outcome)).toBe(row.expected);
      expect(seen).toHaveLength(row.requests);
      expect(JSON.stringify(outcome)).not.toContain("test-key");
      if (row.maxMs !== undefined) expect(ms).toBeLessThan(row.maxMs);
      if (outcome.ok) expect(outcome.message.id).toBe("msg_1");
      if (row.name.includes("carrying the key") && !outcome.ok) {
        expect(outcome.detail).toContain("[key]");
      }
    },
    15_000,
  );

  it("sends the key only as the bearer authorization header", async () => {
    const { seen } = await runRow(rows[0]);
    const [only] = seen;
    expect(only.headers.authorization).toBe("Bearer test-key");
    const otherHeaders = Object.entries(only.headers).filter(
      ([name]) => name !== "authorization",
    );
    expect(JSON.stringify(otherHeaders)).not.toContain("test-key");
    expect(only.url).not.toContain("test-key");
    expect(only.body).not.toContain("test-key");
  });
});
