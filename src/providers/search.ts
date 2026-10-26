// Web search: the outcome types every search call returns.

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
