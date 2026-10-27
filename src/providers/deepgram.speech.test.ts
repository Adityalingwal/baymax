import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeSpeech, transcribeClip } from "./deepgram";
import type { DeepgramAccess, Synthesis } from "./deepgram";

const key = "test-deepgram-key";
const text = "Okay, looking at how Hermes works.";

function bytes(values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

function audioResponse(
  body: Uint8Array<ArrayBuffer> | null,
  headers: Record<string, string> = {},
): () => Promise<Response> {
  return () => Promise.resolve(new Response(body, { status: 200, headers }));
}

function respondWith(body: string, status: number): () => Promise<Response> {
  return () => Promise.resolve(new Response(body, { status }));
}

function brokenBody(): () => Promise<Response> {
  const stream = new ReadableStream({
    start: (controller) => controller.error(new TypeError("body broke")),
  });
  return () => Promise.resolve(new Response(stream, { status: 200 }));
}

function speak(
  respond: () => Promise<Response>,
  signal = new AbortController().signal,
) {
  const fetch = vi.fn<typeof globalThis.fetch>(respond);
  return { fetch, result: synthesizeSpeech({ key, fetch }, text, signal) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synthesizeSpeech request", () => {
  it("posts the text once as JSON to REST speak with the key", async () => {
    const { fetch, result } = speak(audioResponse(bytes([1])));
    await result;

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: `Token ${key}`,
      "Content-Type": "application/json",
    });
    expect(init?.body).toBe(JSON.stringify({ text }));
  });

  it.each([
    { name: "aborted later", before: false },
    { name: "already aborted", before: true },
  ])("the request aborts when the caller's signal is $name", async (row) => {
    const caller = new AbortController();
    if (row.before) caller.abort();
    const { fetch, result } = speak(audioResponse(bytes([1])), caller.signal);
    await result;
    const signal = fetch.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(row.before);
    caller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("the request aborts when its 10 000 ms timeout fires", async () => {
    const timeout = new AbortController();
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const { fetch, result } = speak(audioResponse(bytes([1])));
    await result;
    expect(spy).toHaveBeenCalledWith(10_000);
    const signal = fetch.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    timeout.abort();
    expect(signal?.aborted).toBe(true);
  });
});

type ResultRow = {
  name: string;
  respond: () => Promise<Response>;
  expected: Synthesis;
};

const failedWith = (cause: string): Synthesis =>
  expect.objectContaining({ kind: "failed", cause }) as Synthesis;

const audioOf = (values: number[], mimeType: string): Synthesis => ({
  kind: "audio",
  audio: bytes(values).buffer,
  mimeType,
});

const resultRows: ResultRow[] = [
  {
    name: "the body's exact bytes with the supplied content type",
    respond: audioResponse(bytes([7, 8, 9]), { "Content-Type": "audio/wav" }),
    expected: audioOf([7, 8, 9], "audio/wav"),
  },
  {
    name: "a missing content type is audio/mpeg",
    respond: audioResponse(bytes([4, 5])),
    expected: audioOf([4, 5], "audio/mpeg"),
  },
  {
    name: "an empty body is an error",
    respond: audioResponse(null, { "Content-Type": "audio/mpeg" }),
    expected: failedWith("error"),
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
    name: "a rejected fetch is unreachable",
    respond: () => Promise.reject(new TypeError("fetch failed")),
    expected: failedWith("unreachable"),
  },
  {
    name: "a body read that rejects is an error",
    respond: brokenBody(),
    expected: failedWith("error"),
  },
  {
    name: "a body that echoes the key keeps it out of the detail",
    respond: respondWith(`{"err_msg":"bad header: Token ${key}"}`, 401),
    expected: failedWith("keyRejected"),
  },
];

describe("synthesizeSpeech results", () => {
  it.each(resultRows)("$name", async ({ respond, expected }) => {
    const result = await speak(respond).result;

    expect(result).toEqual(expected);
    if (result.kind === "audio") {
      const audio = expected.kind === "audio" ? expected.audio : null;
      expect([...new Uint8Array(result.audio)]).toEqual([
        ...new Uint8Array(audio ?? new ArrayBuffer(0)),
      ]);
    } else {
      expect(result.detail.length).toBeGreaterThan(0);
      expect(result.detail).not.toContain(key);
    }
  });
});

type ScrubRow = {
  name: string;
  call: (access: DeepgramAccess) => Promise<{ kind: string }>;
  respond: () => Promise<Response>;
  detail: string;
};

// The key starts before character 200 of the raw detail and ends after it.
const bodyEcho = `${"x".repeat(190)}${key}tail`;
const errorEcho = `${"y".repeat(180)}${key}zz`;
const transcribe = (access: DeepgramAccess) =>
  transcribeClip(access, new ArrayBuffer(4), "audio/webm");
const synthesize = (access: DeepgramAccess) =>
  synthesizeSpeech(access, text, new AbortController().signal);

const scrubRows: ScrubRow[] = [
  ...[
    { call: transcribe, label: "transcribeClip" },
    { call: synthesize, label: "synthesizeSpeech" },
  ].flatMap(({ call, label }) => [
    {
      name: `${label}: a response body`,
      call,
      respond: respondWith(bodyEcho, 401),
      detail: `401 ${"x".repeat(190)}[key]t`,
    },
    {
      name: `${label}: a thrown error`,
      call,
      respond: () => Promise.reject(new TypeError(errorEcho)),
      detail: `TypeError: ${"y".repeat(180)}[key]zz`,
    },
  ]),
];

describe("the key is scrubbed before the detail is cut", () => {
  it.each(scrubRows)("$name", async ({ call, respond, detail }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(respond);
    const result = await call({ key, fetch });

    expect(result).toEqual(expect.objectContaining({ kind: "failed", detail }));
  });
});
