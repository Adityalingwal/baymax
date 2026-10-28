import { describe, expect, it, vi } from "vitest";
import { createWarmUp } from "./anthropic";

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
