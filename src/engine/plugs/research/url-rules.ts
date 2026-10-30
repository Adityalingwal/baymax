import { BlockList, isIP } from "node:net";
import { exaApiHost } from "../../../providers/exa";

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

type UrlCheck =
  { ok: true; checked: CheckedUrl } | { ok: false; rule: RefusalRule };

// Lowercased by the URL parser.
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const ipv4Refused: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

// Global unicast only; this also refuses every IPv4-mapped and IPv4-compatible form and the local-use NAT64 prefix 64:ff9b:1::/48.
const ipv6Allowed: [string, number][] = [["2000::", 3]];
const ipv6Refused: [string, number][] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

function blockListOf(
  subnets: [string, number][],
  family: "ipv4" | "ipv6",
): BlockList {
  const list = new BlockList();
  for (const [prefix, bits] of subnets) list.addSubnet(prefix, bits, family);
  return list;
}

// The IPv4 refused ranges inside the well-known NAT64 prefix: macOS on a NAT64 network returns 64:ff9b:: addresses for IPv4-only sites, which reach only the IPv4 they carry.
function nat64Of([prefix, bits]: [string, number]): [string, number] {
  const [a, b, c, d] = prefix.split(".").map(Number);
  const high = (a * 256 + b).toString(16);
  const low = (c * 256 + d).toString(16);
  return [`64:ff9b::${high}:${low}`, 96 + bits];
}

const ipv4RefusedList = blockListOf(ipv4Refused, "ipv4");
const nat64List = blockListOf([["64:ff9b::", 96]], "ipv6");
const nat64RefusedList = blockListOf(ipv4Refused.map(nat64Of), "ipv6");
const ipv6AllowedList = blockListOf(ipv6Allowed, "ipv6");
const ipv6RefusedList = blockListOf(ipv6Refused, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !ipv4RefusedList.check(address, "ipv4");
  if (family === 6) {
    if (nat64List.check(address, "ipv6")) {
      return !nat64RefusedList.check(address, "ipv6");
    }
    return (
      ipv6AllowedList.check(address, "ipv6") &&
      !ipv6RefusedList.check(address, "ipv6")
    );
  }
  return false;
}

const blockedNames = [
  "localhost",
  "local",
  "x.com",
  "linkedin.com",
  "reddit.com",
  exaApiHost,
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
