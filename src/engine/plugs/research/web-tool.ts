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

const aborted: ReadOutcome = { ok: false, cause: "aborted" };

// One shared read per URL: it is cancelled only when every caller waiting on it has aborted, and the last one to leave waits until it has stopped.
type SharedRead = { join: (signal: AbortSignal) => Promise<ReadOutcome> };

function shareRead(
  start: (signal: AbortSignal) => Promise<ReadOutcome>,
): SharedRead {
  const controller = new AbortController();
  const outcome = start(controller.signal);
  let waiting = 0;
  const join = (signal: AbortSignal) =>
    new Promise<ReadOutcome>((resolve) => {
      waiting += 1;
      let left = false;
      const onAbort = () => {
        waiting -= 1;
        left = true;
        if (waiting > 0) resolve(aborted);
        else controller.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const settle = (result: ReadOutcome) => {
        signal.removeEventListener("abort", onAbort);
        resolve(left ? aborted : result);
      };
      outcome.then(settle, () => settle({ ok: false, cause: "unreachable" }));
    });
  return { join };
}

// Pages by source id, findable by the URL asked for and by the final URL.
function createPageStore() {
  const kept: ReadPage[] = [];
  const byKey = new Map<string, ReadPage>();
  return {
    find: (key: string) => byKey.get(key),
    keep: (key: string, page: PageText): ReadPage => {
      const known = byKey.get(page.url);
      const keptPage = known ?? { id: `s${kept.length + 1}`, ...page };
      if (known === undefined) kept.push(keptPage);
      byKey.set(page.url, keptPage);
      byKey.set(key, keptPage);
      return keptPage;
    },
    pages: () => [...kept],
  };
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
  const store = createPageStore();
  const inFlight = new Map<string, SharedRead>();

  async function readAndKeep(
    key: string,
    url: string,
    signal: AbortSignal,
  ): Promise<ReadOutcome> {
    const outcome = await readPage(url, deps, signal);
    inFlight.delete(key);
    return outcome.ok
      ? { ok: true, page: store.keep(key, outcome.page) }
      : outcome;
  }

  function read(url: string, signal: AbortSignal): Promise<ReadOutcome> {
    if (signal.aborted) return Promise.resolve(aborted);
    const check = checkUrl(url);
    if (!check.ok) {
      return Promise.resolve({ ok: false, cause: "refused", rule: check.rule });
    }
    // The same cleaned URL the reader keeps, so a repeat read finds the kept page.
    const key = check.checked.url.href;
    const known = store.find(key);
    if (known !== undefined) return Promise.resolve({ ok: true, page: known });
    let shared = inFlight.get(key);
    if (shared === undefined) {
      shared = shareRead((sharedSignal) => readAndKeep(key, url, sharedSignal));
      inFlight.set(key, shared);
    }
    return shared.join(signal);
  }

  return {
    search: (query, signal) => options.search(query, signal),
    read,
    pages: store.pages,
  };
}
