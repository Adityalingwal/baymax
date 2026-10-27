export type DeepgramAccess = { key: string; fetch: typeof fetch };

export type DeepgramFailure =
  "unreachable" | "keyRejected" | "noCredit" | "error";

type Failure = { kind: "failed"; cause: DeepgramFailure; detail: string }; // detail goes to the dev log only

export type Transcription =
  { kind: "words"; words: string } | { kind: "empty" } | Failure;

export type Synthesis =
  { kind: "audio"; audio: ArrayBuffer; mimeType: string } | Failure;

const baseUrl = "https://api.deepgram.com/v1";
const listenQuery = "model=nova-3&smart_format=true&language=en";
const speakQuery = "model=aura-2-thalia-en&encoding=mp3";
const listenTimeoutMs = 15_000;
const speakTimeoutMs = 10_000;
const detailLimit = 200;
const defaultSpeechMimeType = "audio/mpeg";

function failureForStatus(status: number): DeepgramFailure {
  if (status === 401 || status === 403) return "keyRejected";
  if (status === 402) return "noCredit";
  return "error";
}

// A response or error may echo the request headers; the key never reaches the dev log.
function withoutKey(text: string, key: string): string {
  return key === "" ? text : text.split(key).join("[key]");
}

// Scrubbed before the cut, so a key cut at the limit leaves no prefix behind.
function failed(
  cause: DeepgramFailure,
  rawDetail: string,
  key: string,
): Failure {
  const detail = withoutKey(rawDetail, key).slice(0, detailLimit);
  return { kind: "failed", cause, detail };
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function readTranscript(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.results)) return null;
  const channel = firstItem(body.results.channels);
  if (!isRecord(channel)) return null;
  const alternative = firstItem(channel.alternatives);
  if (!isRecord(alternative)) return null;
  const transcript = alternative.transcript;
  return typeof transcript === "string" ? transcript : null;
}

// Only the fetch itself maps to unreachable; everything after a response exists is mapped by its reader.
async function post(
  access: DeepgramAccess,
  url: string,
  init: RequestInit,
): Promise<{ kind: "response"; response: Response } | Failure> {
  try {
    const response = await access.fetch(url, { method: "POST", ...init });
    return { kind: "response", response };
  } catch (error) {
    return failed("unreachable", describeError(error), access.key);
  }
}

async function readTranscription(
  response: Response,
  key: string,
): Promise<Transcription> {
  try {
    const body = await response.text();
    const detail = `${response.status} ${body}`;
    if (!response.ok) {
      return failed(failureForStatus(response.status), detail, key);
    }
    const transcript = readTranscript(JSON.parse(body));
    if (transcript === null) return failed("error", detail, key);
    const words = transcript.trim();
    return words === "" ? { kind: "empty" } : { kind: "words", words };
  } catch (error) {
    return failed("error", `${response.status} ${describeError(error)}`, key);
  }
}

async function readSynthesis(
  response: Response,
  key: string,
): Promise<Synthesis> {
  try {
    if (!response.ok) {
      const body = await response.text();
      const detail = `${response.status} ${body}`;
      return failed(failureForStatus(response.status), detail, key);
    }
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      return failed("error", `${response.status} empty body`, key);
    }
    const mimeType =
      response.headers.get("Content-Type") ?? defaultSpeechMimeType;
    return { kind: "audio", audio, mimeType };
  } catch (error) {
    return failed("error", `${response.status} ${describeError(error)}`, key);
  }
}

export async function transcribeClip(
  access: DeepgramAccess,
  audio: ArrayBuffer,
  mimeType: string,
): Promise<Transcription> {
  const sent = await post(access, `${baseUrl}/listen?${listenQuery}`, {
    headers: {
      Authorization: `Token ${access.key}`,
      "Content-Type": mimeType,
    },
    body: audio,
    signal: AbortSignal.timeout(listenTimeoutMs),
  });
  if (sent.kind === "failed") return sent;
  return readTranscription(sent.response, access.key);
}

export async function synthesizeSpeech(
  access: DeepgramAccess,
  text: string,
  signal: AbortSignal,
): Promise<Synthesis> {
  const sent = await post(access, `${baseUrl}/speak?${speakQuery}`, {
    headers: {
      Authorization: `Token ${access.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(speakTimeoutMs)]),
  });
  if (sent.kind === "failed") return sent;
  return readSynthesis(sent.response, access.key);
}
