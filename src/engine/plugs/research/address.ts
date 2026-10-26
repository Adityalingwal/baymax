import { BlockList, isIP } from "node:net";

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

// Global unicast only; this also refuses every IPv4-mapped, IPv4-compatible and NAT64 form.
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

const ipv4RefusedList = blockListOf(ipv4Refused, "ipv4");
const ipv6AllowedList = blockListOf(ipv6Allowed, "ipv6");
const ipv6RefusedList = blockListOf(ipv6Refused, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !ipv4RefusedList.check(address, "ipv4");
  if (family === 6) {
    return (
      ipv6AllowedList.check(address, "ipv6") &&
      !ipv6RefusedList.check(address, "ipv6")
    );
  }
  return false;
}
