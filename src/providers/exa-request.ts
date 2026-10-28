export const exaApiHost = "api.exa.ai";

export type ExaFailure =
  | "keyRejected"
  | "quota"
  | "timeout"
  | "unreachable" // network error or a 5xx
  | "badResponse"
  | "aborted";
export type ExaReply =
  { ok: true; body: unknown } | { ok: false; cause: ExaFailure };

function failureFromStatus(status: number): ExaFailure | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "keyRejected";
  // Exa: 402 is out of credits or over the spending budget, 429 a rate limit.
  if (status === 402 || status === 429) return "quota";
  if (status >= 500) return "unreachable";
  return "badResponse";
}

// The combined signal keeps the reason of whichever source fired first.
function failureFromSignals(
  combined: AbortSignal,
  deadline: AbortSignal,
): ExaFailure | null {
  if (!combined.aborted) return null;
  return combined.reason === deadline.reason ? "timeout" : "aborted";
}

function tooLarge(response: Response, maxBytes: number | undefined): boolean {
  if (maxBytes === undefined) return false;
  const length = Number(response.headers.get("content-length") ?? "0");
  return Number.isFinite(length) && length > maxBytes;
}

// One POST to an Exa endpoint with the key in its header, a deadline joined to the caller's signal and the JSON body parsed.
export async function postToExa(params: {
  url: string;
  body: unknown;
  key: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<ExaReply> {
  const { key, signal } = params;
  if (signal.aborted) return { ok: false, cause: "aborted" };
  const deadline = AbortSignal.timeout(params.timeoutMs ?? 10_000);
  const combined = AbortSignal.any([signal, deadline]);
  const request: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify(params.body),
    // A custom key header survives a cross-origin redirect, so never follow one.
    redirect: "error",
    signal: combined,
  };
  try {
    const response = await params.fetch(params.url, request);
    const failure =
      failureFromStatus(response.status) ??
      (tooLarge(response, params.maxBytes) ? "badResponse" : null);
    if (failure !== null) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, cause: failure };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    const cause = failureFromSignals(combined, deadline);
    if (cause !== null) return { ok: false, cause };
    return {
      ok: false,
      cause: error instanceof SyntaxError ? "badResponse" : "unreachable",
    };
  }
}
