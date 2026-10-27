export type SearchHit = { url: string; title: string; snippet: string };
export type SearchFailure =
  | "keyRejected"
  | "quota"
  | "timeout"
  | "unreachable" // network error or a 5xx
  | "badResponse"
  | "aborted";
export type SearchOutcome =
  { ok: true; hits: SearchHit[] } | { ok: false; cause: SearchFailure };
export type SearchFn = (
  query: string,
  signal: AbortSignal,
) => Promise<SearchOutcome>;

const exaSearchUrl = "https://api.exa.ai/search";
const snippetChars = 500;

function failureFromStatus(status: number): SearchFailure | null {
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
): SearchFailure | null {
  if (!combined.aborted) return null;
  return combined.reason === deadline.reason ? "timeout" : "aborted";
}

function hitFrom(result: unknown): SearchHit | null {
  if (typeof result !== "object" || result === null) return null;
  const { url, title, highlights } = result as Record<string, unknown>;
  if (typeof url !== "string") return null;
  const parts = Array.isArray(highlights)
    ? highlights.filter((part): part is string => typeof part === "string")
    : [];
  return {
    url,
    title:
      typeof title === "string" && title.trim() !== "" ? title.trim() : url,
    snippet: parts
      .join(" … ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, snippetChars),
  };
}

function hitsFrom(body: unknown): SearchHit[] | null {
  if (typeof body !== "object" || body === null) return null;
  const { results } = body as Record<string, unknown>;
  if (!Array.isArray(results)) return null;
  const hits = results.map(hitFrom);
  return hits.every((hit): hit is SearchHit => hit !== null) ? hits : null;
}

// Exa's lite search with up to 500 characters of highlights per hit: its cheapest call that returns a snippet.
export async function searchWeb(params: {
  query: string;
  key: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  maxResults?: number;
  timeoutMs?: number;
}): Promise<SearchOutcome> {
  const { query, key, signal } = params;
  if (signal.aborted) return { ok: false, cause: "aborted" };
  const deadline = AbortSignal.timeout(params.timeoutMs ?? 10_000);
  const combined = AbortSignal.any([signal, deadline]);
  const request: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      query,
      numResults: params.maxResults ?? 5,
      type: "lite",
      contents: { highlights: { maxCharacters: snippetChars } },
    }),
    // A custom key header survives a cross-origin redirect, so never follow one.
    redirect: "error",
    signal: combined,
  };
  try {
    const response = await params.fetch(exaSearchUrl, request);
    const failure = failureFromStatus(response.status);
    if (failure !== null) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, cause: failure };
    }
    const hits = hitsFrom(await response.json());
    // A body that echoes the key must not carry it into the model's text.
    return hits === null || JSON.stringify(hits).includes(key)
      ? { ok: false, cause: "badResponse" }
      : { ok: true, hits };
  } catch (error) {
    const cause = failureFromSignals(combined, deadline);
    if (cause !== null) return { ok: false, cause };
    return {
      ok: false,
      cause: error instanceof SyntaxError ? "badResponse" : "unreachable",
    };
  }
}
