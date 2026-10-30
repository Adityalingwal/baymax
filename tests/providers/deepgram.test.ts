import { describe, expect, it, vi } from "vitest";
import { transcribeClip } from "../../src/providers/deepgram";
import type { Transcription } from "../../src/providers/deepgram";

const key = "test-deepgram-key";
const audio = new ArrayBuffer(8);
const mimeType = "audio/webm;codecs=opus";

function transcriptBody(transcript: string): string {
  return JSON.stringify({
    metadata: { request_id: "r1" },
    results: { channels: [{ alternatives: [{ transcript }] }] },
  });
}

function respondWith(body: string, status = 200): () => Promise<Response> {
  return () => Promise.resolve(new Response(body, { status }));
}

describe("transcribeClip request", () => {
  it("posts the raw clip once to pre-recorded listen with the key and the mime type", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      respondWith(transcriptBody("hi")),
    );
    await transcribeClip({ key, fetch }, audio, mimeType);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=en",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Token ${key}`,
      "Content-Type": mimeType,
    });
    expect(init?.body).toBe(audio);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

type ResultRow = {
  name: string;
  respond: () => Promise<Response>;
  expected: Transcription;
};

const failedWith = (cause: string): Transcription =>
  expect.objectContaining({ kind: "failed", cause }) as Transcription;

const resultRows: ResultRow[] = [
  {
    name: "a transcript is trimmed into words",
    respond: respondWith(transcriptBody("  hello there ")),
    expected: { kind: "words", words: "hello there" },
  },
  {
    name: "an empty transcript is empty",
    respond: respondWith(transcriptBody("")),
    expected: { kind: "empty" },
  },
  {
    name: "401 is a rejected key",
    respond: respondWith('{"err_msg":"Invalid credentials."}', 401),
    expected: failedWith("keyRejected"),
  },
  {
    name: "403 is a rejected key",
    respond: respondWith('{"err_msg":"No access to the model."}', 403),
    expected: failedWith("keyRejected"),
  },
  {
    name: "402 is no credit",
    respond: respondWith('{"err_msg":"Not enough credits."}', 402),
    expected: failedWith("noCredit"),
  },
  {
    name: "500 is an error",
    respond: respondWith("Internal Server Error", 500),
    expected: failedWith("error"),
  },
  {
    name: "a 200 without results is an error",
    respond: respondWith('{"metadata":{}}'),
    expected: failedWith("error"),
  },
  {
    name: "a 200 with a body that is not JSON is an error",
    respond: respondWith("<html>proxy</html>"),
    expected: failedWith("error"),
  },
  {
    name: "a body that echoes the key keeps it out of the detail",
    respond: respondWith(`{"err_msg":"bad header: Token ${key}"}`, 401),
    expected: failedWith("keyRejected"),
  },
  {
    name: "an error that echoes the key keeps it out of the detail",
    respond: () => Promise.reject(new TypeError(`Authorization: Token ${key}`)),
    expected: failedWith("unreachable"),
  },
  {
    name: "a network failure is unreachable",
    respond: () => Promise.reject(new TypeError("fetch failed")),
    expected: failedWith("unreachable"),
  },
  {
    name: "a timeout is unreachable",
    respond: () =>
      Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError"),
      ),
    expected: failedWith("unreachable"),
  },
];

describe("transcribeClip results", () => {
  it.each(resultRows)("$name", async ({ respond, expected }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(respond);
    const result = await transcribeClip({ key, fetch }, audio, mimeType);

    expect(result).toEqual(expected);
    if (result.kind === "failed") {
      expect(result.detail.length).toBeGreaterThan(0);
      expect(result.detail).not.toContain(key);
    }
  });
});
