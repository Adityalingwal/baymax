import type { SearchFn, SearchOutcome } from "../../../providers/search";
import { connectSocket, lookupHost } from "./connection";
import type { Connect, LookupAll } from "./connection";
import type { PageText, ReadPage } from "./page-text";
import { readPage } from "./read-page";
import type { ReadFailure, ReadLimits } from "./read-page";

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

// The URL without its fragment; null when it does not parse.
function readKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function keepPage(kept: ReadPage[], page: PageText): ReadPage {
  const key = readKey(page.url);
  const known = kept.find((keptPage) => readKey(keptPage.url) === key);
  if (known !== undefined) return known;
  const added: ReadPage = { id: `s${kept.length + 1}`, ...page };
  kept.push(added);
  return added;
}

// One web tool per task: it holds every page the task read, by source id.
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
  const reads = new Map<string, Promise<ReadOutcome>>();

  async function readAndKeep(
    key: string | null,
    url: string,
    signal: AbortSignal,
  ): Promise<ReadOutcome> {
    const outcome = await readPage(url, deps, signal);
    if (!outcome.ok) {
      if (key !== null) reads.delete(key);
      return outcome;
    }
    const success = { ok: true, page: keepPage(kept, outcome.page) } as const;
    const finalKey = readKey(success.page.url);
    if (finalKey !== null) reads.set(finalKey, Promise.resolve(success));
    return success;
  }

  function read(url: string, signal: AbortSignal): Promise<ReadOutcome> {
    const key = readKey(url);
    // A URL that does not parse goes to the reader, which refuses it.
    if (key === null) return readAndKeep(null, url, signal);
    const known = reads.get(key);
    if (known !== undefined) return known;
    const pending = readAndKeep(key, url, signal);
    reads.set(key, pending);
    return pending;
  }

  return {
    search: (query, signal) => options.search(query, signal),
    read,
    pages: () => [...kept],
  };
}
