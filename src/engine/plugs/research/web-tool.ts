import type {
  ContentsFn,
  SearchFn,
  SearchOutcome,
} from "../../../providers/exa";
import { connectSocket, lookupHost } from "./connection";
import type { Connect, LookupAll } from "./connection";
import { pageTextFrom } from "./page-text";
import type { PageText, ReadPage } from "./page-text";
import { readPage } from "./read-page";
import type { PageOutcome, ReadFailure, ReadLimits } from "./read-page";
import { checkUrl } from "./url-rules";
import type { CheckedUrl } from "./url-rules";

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
  maxChars: 20_000,
  minChars: 200,
};

const aborted: ReadFailure = { ok: false, cause: "aborted" };

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

// Exa's text kept under the checked URL that was asked for; Exa's own URL only matched its result.
function hostedPage(
  checked: CheckedUrl,
  hosted: { title: string; text: string },
  limits: ReadLimits,
): PageOutcome | null {
  const outcome = pageTextFrom({
    body: hosted.text,
    kind: "plain",
    url: checked.url.href,
    hostname: checked.hostname,
    limits,
    title: hosted.title,
  });
  return outcome.ok ? outcome : null;
}

type Readers = {
  contents: ContentsFn;
  lookup: LookupAll;
  connect: Connect;
  limits: ReadLimits;
};

// Exa Contents first; Baymax's own reader when Exa has no usable text or fails, but never after an abort.
async function readEither(
  readers: Readers,
  checked: CheckedUrl,
  url: string,
  signal: AbortSignal,
): Promise<PageOutcome> {
  const hosted = await readers.contents(checked.url.href, signal);
  if (signal.aborted) return aborted;
  const page = hosted.ok ? hostedPage(checked, hosted, readers.limits) : null;
  return page ?? readPage(url, readers, signal);
}

type WebToolOptions = {
  search: SearchFn;
  contents: ContentsFn;
  lookup?: LookupAll;
  connect?: Connect;
  limits?: Partial<ReadLimits>;
};

function readersFrom(options: WebToolOptions): Readers {
  return {
    contents: options.contents,
    lookup: options.lookup ?? lookupHost,
    connect: options.connect ?? connectSocket,
    limits: { ...defaultLimits, ...options.limits },
  };
}

export function createWebTool(options: WebToolOptions): WebTool {
  const readers = readersFrom(options);
  const store = createPageStore();
  const inFlight = new Map<string, SharedRead>();

  // The key is the cleaned URL the reader keeps, so a repeat read finds the kept page.
  async function readAndKeep(
    checked: CheckedUrl,
    url: string,
    signal: AbortSignal,
  ): Promise<ReadOutcome> {
    const key = checked.url.href;
    const outcome = await readEither(readers, checked, url, signal);
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
    const { checked } = check;
    const known = store.find(checked.url.href);
    if (known !== undefined) return Promise.resolve({ ok: true, page: known });
    let shared = inFlight.get(checked.url.href);
    if (shared === undefined) {
      shared = shareRead((sharedSignal) =>
        readAndKeep(checked, url, sharedSignal),
      );
      inFlight.set(checked.url.href, shared);
    }
    return shared.join(signal);
  }

  return {
    search: (query, signal) => options.search(query, signal),
    read,
    pages: store.pages,
  };
}
