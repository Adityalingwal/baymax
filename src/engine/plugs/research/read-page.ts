import http from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import { createGuardedConnection, refusalOf } from "./connection";
import type { Connect, LookupAll } from "./connection";
import { pageTextFrom } from "./page-text";
import type { BodyKind, PageText } from "./page-text";
import { decodeText, isDecompressionFailure, readBody } from "./response-body";
import type { BodyEncoding } from "./response-body";
import { checkUrl } from "./url-rules";
import type { CheckedUrl, RefusalRule } from "./url-rules";

export type ReadFailure =
  | { ok: false; cause: "refused"; rule: RefusalRule }
  | {
      ok: false;
      cause:
        "noUsableText" | "httpError" | "timeout" | "unreachable" | "aborted";
    };
export type PageOutcome = { ok: true; page: PageText } | ReadFailure;
export type ReadLimits = {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  maxChars: number;
  minChars: number;
};
type ReadDeps = { lookup: LookupAll; connect: Connect; limits: ReadLimits };
type Exchange = { request: ClientRequest; response: IncomingMessage };

// What to do with a response, decided from its status and headers before any body is read.
type Decision =
  | { next: "redirect"; location: string }
  | {
      next: "read";
      kind: BodyKind;
      encoding: BodyEncoding;
      charset: string | null;
    }
  | { next: "stop"; outcome: ReadFailure };

const requestHeaders = {
  "User-Agent": "Baymax/0.1 (research assistant)",
  Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
  "Accept-Encoding": "gzip, br",
  "Accept-Language": "en",
};

const redirectStatuses = [301, 302, 303, 307, 308];

function refused(rule: RefusalRule): ReadFailure {
  return { ok: false, cause: "refused", rule };
}

function failed(cause: "noUsableText" | "httpError"): ReadFailure {
  return { ok: false, cause };
}

function send(
  checked: CheckedUrl,
  deps: ReadDeps,
  signal: AbortSignal,
): Promise<Exchange> {
  const transport = checked.tls ? https : http;
  const defaultPort = checked.tls ? 443 : 80;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        host: checked.hostname,
        port: checked.port,
        defaultPort,
        path: checked.url.pathname + checked.url.search,
        method: "GET",
        headers: requestHeaders,
        signal,
        createConnection: createGuardedConnection(checked, deps, signal),
      },
      (response) => {
        // Errors after the body is abandoned are expected; the body reader reports its own.
        response.on("error", () => undefined);
        resolve({ request, response });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function bodyKind(contentType: string | undefined): BodyKind | null {
  const type = (contentType ?? "text/html").split(";")[0].trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/plain") return "plain";
  return null;
}

function bodyEncoding(
  contentEncoding: string | undefined,
): BodyEncoding | null {
  const value = (contentEncoding ?? "").trim().toLowerCase();
  if (value === "" || value === "identity") return "identity";
  if (value === "gzip" || value === "br") return value;
  return null;
}

function charsetOf(contentType: string | undefined): string | null {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "");
  return match === null ? null : match[1];
}

function decide(response: IncomingMessage): Decision {
  const status = response.statusCode ?? 0;
  if (redirectStatuses.includes(status)) {
    const location = response.headers.location;
    return location === undefined
      ? { next: "stop", outcome: failed("httpError") }
      : { next: "redirect", location };
  }
  if (status < 200 || status > 299) {
    return { next: "stop", outcome: failed("httpError") };
  }
  const encoding = bodyEncoding(response.headers["content-encoding"]);
  const kind = bodyKind(response.headers["content-type"]);
  if (encoding === null || kind === null) {
    return { next: "stop", outcome: failed("noUsableText") };
  }
  const charset = charsetOf(response.headers["content-type"]);
  return { next: "read", kind, encoding, charset };
}

function close(exchange: Exchange): void {
  exchange.response.destroy();
  exchange.request.destroy();
}

async function readDecided(
  exchange: Exchange,
  checked: CheckedUrl,
  decision: Extract<Decision, { next: "read" }>,
  limits: ReadLimits,
): Promise<PageOutcome> {
  try {
    const bytes = await readBody(
      exchange.response,
      decision.encoding,
      limits.maxBytes,
    );
    return pageTextFrom({
      body: decodeText(bytes, decision.charset),
      kind: decision.kind,
      url: checked.url.href,
      hostname: checked.hostname,
      limits,
    });
  } finally {
    close(exchange);
  }
}

async function followRedirects(
  url: string,
  deps: ReadDeps,
  signal: AbortSignal,
): Promise<PageOutcome> {
  let current = url;
  let base: string | undefined;
  for (let redirects = 0; ; redirects += 1) {
    const check = checkUrl(current, base);
    if (!check.ok) return refused(check.rule);
    const exchange = await send(check.checked, deps, signal);
    const decision = decide(exchange.response);
    if (decision.next === "read") {
      return readDecided(exchange, check.checked, decision, deps.limits);
    }
    close(exchange);
    if (decision.next === "stop") return decision.outcome;
    if (redirects >= deps.limits.maxRedirects)
      return refused("tooManyRedirects");
    base = check.checked.url.href;
    current = decision.location;
  }
}

function failureFrom(
  err: unknown,
  caller: AbortSignal,
  deadline: AbortSignal | null,
): ReadFailure {
  if (caller.aborted) return { ok: false, cause: "aborted" };
  if (deadline?.aborted === true) return { ok: false, cause: "timeout" };
  const rule = refusalOf(err);
  if (rule !== null) return refused(rule);
  if (isDecompressionFailure(err)) return failed("noUsableText");
  return { ok: false, cause: "unreachable" };
}

export async function readPage(
  url: string,
  deps: ReadDeps,
  signal: AbortSignal,
): Promise<PageOutcome> {
  if (signal.aborted) return { ok: false, cause: "aborted" };
  let deadline: AbortSignal | null = null;
  try {
    deadline = AbortSignal.timeout(deps.limits.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    return await followRedirects(url, deps, combined);
  } catch (err) {
    return failureFrom(err, signal, deadline);
  }
}
