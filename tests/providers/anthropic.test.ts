import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelCall,
  createTextStream,
  createWarmUp,
} from "../../src/providers/anthropic";
import type { ModelFailure, ModelOutcome } from "../../src/providers/anthropic";
import type { Respond } from "./anthropic.harness";
import {
  destroySocket,
  localFetch,
  request,
  startServer,
} from "./anthropic.harness";

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

describe("createModelCall logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prints nothing from the SDK even with ANTHROPIC_LOG=debug", async () => {
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const methods = ["log", "info", "debug", "warn", "error"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const { outcome } = await runRow(rows[0]);
    expect(outcome.ok).toBe(true);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// The SDK's shortest backoff before its one retry: 500 ms less up to 25 percent jitter.
const shortestBackoffMs = 375;

// Fails the first request at the socket and notes when it failed, so a test can act inside the backoff.
function firstFails(port: number) {
  const viaServer = localFetch(port);
  let calls = 0;
  let failedAt = 0;
  let markFailed = (): void => undefined;
  const failed = new Promise<void>((resolve) => (markFailed = resolve));
  const fetchOnce: typeof fetch = async (input, init) => {
    calls += 1;
    try {
      return await viaServer(input, init);
    } catch (error) {
      failedAt = performance.now();
      markFailed();
      throw error;
    }
  };
  return {
    fetchOnce,
    failed,
    calls: () => calls,
    failedAt: () => failedAt,
  };
}

describe("createModelCall during the retry wait", () => {
  it("returns aborted promptly when the caller aborts in the backoff", async () => {
    const server = await startServer(destroySocket);
    const fake = firstFails(server.port);
    const call = createModelCall({ apiKey: "test-key", fetch: fake.fetchOnce });
    const controller = new AbortController();
    const pending = call(request, {
      timeoutMs: 5_000,
      deadlineMs: 8_000,
      signal: controller.signal,
    });
    await fake.failed;
    // Only microtasks run between the failed fetch and the SDK's sleep, so a timer fires inside the sleep.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const outcome = await pending;
    const sinceFailure = performance.now() - fake.failedAt();
    await server.stop();
    expect(outcome.ok ? "ok" : outcome.failure).toBe("aborted");
    // A sleep that ignored the abort would end no earlier than the shortest backoff after the failure.
    expect(sinceFailure).toBeLessThan(shortestBackoffMs);
    expect(fake.calls()).toBe(1);
    expect(server.seen).toHaveLength(1);
  });
});

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the connection warm-up", () => {
  it.each([
    {
      outcome: "answered",
      fetch: async () => new Response("", { status: 401 }),
    },
    {
      outcome: "unreachable",
      fetch: async () => Promise.reject(new Error("offline")),
    },
  ])(
    "sends one key-less request to the API and ignores it when $outcome",
    async ({ fetch }) => {
      const send = vi.fn(fetch);
      createWarmUp({ fetch: send })();
      await flush();
      expect(send).toHaveBeenCalledTimes(1);
      const [url, init] = send.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("https://api.anthropic.com/v1/models");
      expect(JSON.stringify(init.headers)).not.toMatch(
        /x-api-key|authorization/i,
      );
    },
  );
});
