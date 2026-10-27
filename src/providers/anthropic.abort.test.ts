import { describe, expect, it } from "vitest";
import { createModelCall } from "./anthropic";
import {
  destroySocket,
  localFetch,
  request,
  startServer,
} from "./anthropic.harness";

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
    // The rejection reaches the SDK's sleep within a few microtasks; this lands well inside it.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const outcome = await pending;
    const sinceFailure = performance.now() - fake.failedAt();
    await server.stop();
    expect(outcome.ok ? "ok" : outcome.failure).toBe("aborted");
    expect(sinceFailure).toBeLessThan(shortestBackoffMs / 2);
    expect(fake.calls()).toBe(1);
    expect(server.seen).toHaveLength(1);
  });
});
