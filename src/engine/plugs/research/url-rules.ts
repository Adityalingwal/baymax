import { isIP } from "node:net";
import { isPublicAddress } from "./address";

export type RefusalRule =
  | "scheme"
  | "credentials"
  | "blockedHost"
  | "privateAddress"
  | "tooManyRedirects";

export type CheckedUrl = {
  url: URL;
  hostname: string;
  port: number;
  tls: boolean;
  literal: boolean;
};

export type UrlCheck =
  { ok: true; checked: CheckedUrl } | { ok: false; rule: RefusalRule };

const blockedNames = [
  "localhost",
  "local",
  "x.com",
  "linkedin.com",
  "reddit.com",
];

function parse(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

function isBlockedName(hostname: string): boolean {
  return blockedNames.some(
    (name) => hostname === name || hostname.endsWith(`.${name}`),
  );
}

// The fragment and a trailing dot are dropped, so the kept URL, the lookup, Host and TLS all use one name.
function cleaned(url: URL): URL {
  url.hash = "";
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  return url;
}

function bareHostname(url: URL): string {
  const name = url.hostname.toLowerCase();
  return name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
}

export function checkUrl(raw: string, base?: string): UrlCheck {
  const parsed = parse(raw, base);
  if (parsed === null) return { ok: false, rule: "scheme" };
  const url = cleaned(parsed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, rule: "scheme" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, rule: "credentials" };
  }
  const hostname = bareHostname(url);
  if (isBlockedName(hostname)) return { ok: false, rule: "blockedHost" };
  const literal = isIP(hostname) !== 0;
  if (literal && !isPublicAddress(hostname)) {
    return { ok: false, rule: "privateAddress" };
  }
  const tls = url.protocol === "https:";
  const port = url.port === "" ? (tls ? 443 : 80) : Number(url.port);
  return { ok: true, checked: { url, hostname, port, tls, literal } };
}
