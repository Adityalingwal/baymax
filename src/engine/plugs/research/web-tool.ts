import type { SearchFn, SearchOutcome } from "../../../providers/search";
import { connectSocket, lookupHost } from "./connection";
import type { Connect, LookupAll } from "./connection";
import type { PageText, ReadPage } from "./page-text";
import { readPage } from "./read-page";
import type { ReadFailure, ReadLimits } from "./read-page";
import { checkUrl } from "./url-rules";

export type ReadOutcome = { ok: true; page: ReadPage } | ReadFailure;
export type WebTool = {
  search: (query: string, signal: AbortSignal) => Promise<SearchOutcome>;
  read: (url: string, signal: AbortSignal) => Promise<ReadOutcome>;
  pages: () => ReadPage[]; // every page read so far, in read order
};

const defaultLimits: ReadLimits = {
  maxBytes: 1_000_000,
  timeoutMs: 10_000,
  maxRedirects: 5,
  maxChars: 8_000,
  minChars: 200,
};

// The same cleaned URL the reader keeps, so a repeat read finds the kept page.
function readKey(url: string): string | null {
  const check = checkUrl(url);
  return check.ok ? check.checked.url.href : null;
}

function keepPage(kept: ReadPage[], page: PageText): ReadPage {
  const known = kept.find((keptPage) => keptPage.url === page.url);
  if (known !== undefined) return known;
  const added: ReadPage = { id: `s${kept.length + 1}`, ...page };
  kept.push(added);
  return added;
}

export function createWebTool(options: {
  search: SearchFn;
  lookup?: LookupAll;
  connect?: Connect;
  limits?: Partial<ReadLimits>;
}): WebTool {
  const deps = {
    lookup: options.lookup ?? lookupHost,
    connect: options.connect ?? connectSocket,
    limits: { ...defaultLimits, ...options.limits },
  };
  const kept: ReadPage[] = [];
  const inFlight = new Map<string, Promise<ReadOutcome>>();

  async function readAndKeep(
    url: string,
    signal: AbortSignal,
  ): Promise<ReadOutcome> {
    const outcome = await readPage(url, deps, signal);
    return outcome.ok
      ? { ok: true, page: keepPage(kept, outcome.page) }
      : outcome;
  }

  function read(url: string, signal: AbortSignal): Promise<ReadOutcome> {
    const key = readKey(url);
    if (key === null) return readAndKeep(url, signal);
    const known = kept.find((page) => page.url === key);
    if (known !== undefined) return Promise.resolve({ ok: true, page: known });
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const started = readAndKeep(url, signal).finally(() =>
      inFlight.delete(key),
    );
    inFlight.set(key, started);
    return started;
  }

  return {
    search: (query, signal) => options.search(query, signal),
    read,
    pages: () => [...kept],
  };
}
