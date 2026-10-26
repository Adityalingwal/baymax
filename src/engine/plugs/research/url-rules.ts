import { isIP } from "node:net";
import { isPublicAddress } from "./address";

export type RefusalRule =
  | "scheme"
  | "credentials"
  | "blockedHost"
  | "privateAddress"
  | "tooManyRedirects";

// A URL that may be requested: the stripped hostname is used for the lookup, Host and TLS.
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

function strippedHostname(url: URL): string {
  const lower = url.hostname.toLowerCase();
  const name = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  return name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
}

export function checkUrl(raw: string, base?: string): UrlCheck {
  const url = parse(raw, base);
  if (url === null) return { ok: false, rule: "scheme" };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, rule: "scheme" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, rule: "credentials" };
  }
  const hostname = strippedHostname(url);
  if (isBlockedName(hostname)) return { ok: false, rule: "blockedHost" };
  const literal = isIP(hostname) !== 0;
  if (literal && !isPublicAddress(hostname)) {
    return { ok: false, rule: "privateAddress" };
  }
  const tls = url.protocol === "https:";
  const port = url.port === "" ? (tls ? 443 : 80) : Number(url.port);
  return { ok: true, checked: { url, hostname, port, tls, literal } };
}
