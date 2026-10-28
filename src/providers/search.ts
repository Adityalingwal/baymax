import { postToExa } from "./exa-request";
import type { ExaFailure } from "./exa-request";

export type SearchHit = { url: string; title: string; snippet: string };
export type SearchFailure = ExaFailure;
export type SearchOutcome =
  { ok: true; hits: SearchHit[] } | { ok: false; cause: SearchFailure };
export type SearchFn = (
  query: string,
  signal: AbortSignal,
) => Promise<SearchOutcome>;

const exaSearchUrl = "https://api.exa.ai/search";
const snippetChars = 500;

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
  const { query, key } = params;
  const reply = await postToExa({
    url: exaSearchUrl,
    body: {
      query,
      numResults: params.maxResults ?? 5,
      type: "lite",
      contents: { highlights: { maxCharacters: snippetChars } },
    },
    key,
    fetch: params.fetch,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  if (!reply.ok) return reply;
  const hits = hitsFrom(reply.body);
  // A body that echoes the key must not carry it into the model's text.
  return hits === null || JSON.stringify(hits).includes(key)
    ? { ok: false, cause: "badResponse" }
    : { ok: true, hits };
}
