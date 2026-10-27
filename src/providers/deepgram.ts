export type DeepgramAccess = { key: string; fetch: typeof fetch };

export type DeepgramFailure =
  "unreachable" | "keyRejected" | "noCredit" | "error";

export type Transcription =
  | { kind: "words"; words: string }
  | { kind: "empty" }
  | { kind: "failed"; cause: DeepgramFailure; detail: string }; // detail goes to the dev log only

const baseUrl = "https://api.deepgram.com/v1";
const listenQuery = "model=nova-3&smart_format=true&language=en";
const timeoutMs = 15_000;
const detailLimit = 200;

function failureForStatus(status: number): DeepgramFailure {
  if (status === 401 || status === 403) return "keyRejected";
  if (status === 402) return "noCredit";
  return "error";
}

function failed(cause: DeepgramFailure, detail: string): Transcription {
  return { kind: "failed", cause, detail };
}

function describeError(error: unknown): string {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, detailLimit);
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

async function readTranscription(response: Response): Promise<Transcription> {
  try {
    const body = await response.text();
    const detail = `${response.status} ${body.slice(0, detailLimit)}`;
    if (!response.ok) return failed(failureForStatus(response.status), detail);
    const transcript = readTranscript(JSON.parse(body));
    if (transcript === null) return failed("error", detail);
    const words = transcript.trim();
    return words === "" ? { kind: "empty" } : { kind: "words", words };
  } catch (error) {
    return failed("error", `${response.status} ${describeError(error)}`);
  }
}

// A response or error may echo the request headers; the key never reaches the dev log.
function withoutKey(result: Transcription, key: string): Transcription {
  if (result.kind !== "failed" || key === "") return result;
  return { ...result, detail: result.detail.split(key).join("[key]") };
}

export async function transcribeClip(
  access: DeepgramAccess,
  audio: ArrayBuffer,
  mimeType: string,
): Promise<Transcription> {
  let response: Response;
  try {
    response = await access.fetch(`${baseUrl}/listen?${listenQuery}`, {
      method: "POST",
      headers: {
        Authorization: `Token ${access.key}`,
        "Content-Type": mimeType,
      },
      body: audio,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return withoutKey(failed("unreachable", describeError(error)), access.key);
  }
  return withoutKey(await readTranscription(response), access.key);
}
