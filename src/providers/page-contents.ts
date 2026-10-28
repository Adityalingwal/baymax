import { postToExa } from "./exa-request";
import type { ExaFailure } from "./exa-request";

export type ContentsFailure = ExaFailure | "noUsableText";
export type ContentsOutcome =
  | { ok: true; title: string; text: string } // title is Exa's, trimmed; "" when it gave none
  | { ok: false; cause: ContentsFailure };
export type ContentsFn = (
  url: string,
  signal: AbortSignal,
) => Promise<ContentsOutcome>;

const exaContentsUrl = "https://api.exa.ai/contents";
const maxBodyBytes = 1_000_000;
const minTextChars = 200;

const noUsableText: ContentsOutcome = { ok: false, cause: "noUsableText" };

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
  if (!succeededInStatuses(statuses, url)) return noUsableText;
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
}): Promise<ContentsOutcome> {
  const { url, key } = params;
  const reply = await postToExa({
    url: exaContentsUrl,
    body: { urls: [url], text: { maxCharacters: params.maxChars ?? 20_000 } },
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
