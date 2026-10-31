export const exaApiHost = "api.exa.ai";

type ExaFailure =
  | "keyRejected"
  | "quota"
  | "timeout"
  | "unreachable" // network error or a 5xx
  | "badResponse"
  | "aborted";
type ExaReply = { ok: true; body: unknown } | { ok: false; cause: ExaFailure };

export type SearchHit = { url: string; title: string; snippet: string };
export type SearchFailure = ExaFailure;
export type SearchOutcome =
  { ok: true; hits: SearchHit[] } | { ok: false; cause: SearchFailure };
export type SearchFn = (
  query: string,
  signal: AbortSignal,
) => Promise<SearchOutcome>;
type ContentsFailure = ExaFailure | "noUsableText";
export type ContentsOutcome =
  | { ok: true; title: string; text: string } // title is Exa's, trimmed; "" when it gave none
  | { ok: false; cause: ContentsFailure; tag?: string }; // tag is Exa's own for this URL, for the log
export type ContentsFn = (
  url: string,
  signal: AbortSignal,
  fresh: boolean, // true skips Exa's cache and fetches the page again
) => Promise<ContentsOutcome>;

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
async function postToExa(params: {
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

const exaSearchUrl = `https://${exaApiHost}/search`;
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

// Exa's auto search with up to 500 characters of highlights per hit.
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
      numResults: params.maxResults ?? 10,
      type: "auto",
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

const exaContentsUrl = `https://${exaApiHost}/contents`;
const maxBodyBytes = 1_000_000;
const minTextChars = 200;

const noUsableText: Extract<ContentsOutcome, { ok: false }> = {
  ok: false,
  cause: "noUsableText",
};

function fieldsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Exa marks each URL as "success" or "error" in statuses; text counts only with a well-formed "success" for this URL.
function succeededInStatuses(statuses: unknown[], url: string): boolean {
  const entries = statuses.map(fieldsOf);
  const wellFormed = entries.every(
    (fields) =>
      fields !== null &&
      typeof fields.id === "string" &&
      typeof fields.status === "string",
  );
  if (!wellFormed) return false;
  const own = entries.filter((fields) => fields?.id === url);
  return own.length > 0 && own.every((fields) => fields?.status === "success");
}

// Exa's error tag for this URL, kept only in its known form so no page or provider text reaches the log.
function noTextWithTag(statuses: unknown[], url: string): ContentsOutcome {
  for (const entry of statuses) {
    const fields = fieldsOf(entry);
    const tag = fieldsOf(fields?.error)?.tag;
    if (fields?.id === url && typeof tag === "string") {
      return /^[A-Z0-9_]+$/.test(tag) ? { ...noUsableText, tag } : noUsableText;
    }
  }
  return noUsableText;
}

function matchingResult(results: unknown[], url: string) {
  for (const result of results) {
    const fields = fieldsOf(result);
    if (fields !== null && (fields.id === url || fields.url === url)) {
      return fields;
    }
  }
  return null;
}

function outcomeFrom(body: unknown, url: string): ContentsOutcome {
  const fields = fieldsOf(body);
  if (fields === null) return noUsableText;
  const { results, statuses } = fields;
  if (!Array.isArray(results) || !Array.isArray(statuses)) return noUsableText;
  if (!succeededInStatuses(statuses, url)) return noTextWithTag(statuses, url);
  const result = matchingResult(results, url);
  if (result === null || typeof result.text !== "string") return noUsableText;
  const { text } = result;
  if (text.replace(/\s/g, "").length < minTextChars) return noUsableText;
  const title = typeof result.title === "string" ? result.title.trim() : "";
  return { ok: true, title, text };
}

// Exa Contents: the text of one page as Exa's own crawler or cache has it, which covers JavaScript-built pages and PDFs.
export async function readPageContents(params: {
  url: string;
  key: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
  maxChars?: number;
  fresh?: boolean;
}): Promise<ContentsOutcome> {
  const { url, key } = params;
  const reply = await postToExa({
    url: exaContentsUrl,
    body: {
      urls: [url],
      text: { maxCharacters: params.maxChars ?? 20_000 },
      ...(params.fresh === true ? { maxAgeHours: 0 } : {}),
    },
    key,
    fetch: params.fetch,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    maxBytes: maxBodyBytes,
  });
  if (!reply.ok) return reply;
  const outcome = outcomeFrom(reply.body, url);
  // A body that echoes the key must not carry it into the model's text.
  if (
    outcome.ok &&
    [outcome.title, outcome.text].some((t) => t.includes(key))
  ) {
    return { ok: false, cause: "badResponse" };
  }
  return outcome;
}
