import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ConnectTarget,
  LookupAll,
} from "../../../../src/engine/plugs/research/connection";
import {
  dripRoute,
  readablePage,
  readThrough,
  sendRoute,
  startFakeNetwork,
  testLimits,
} from "./fake-network";
import type { FakeNetwork, FakeRoute } from "./fake-network";
import type { PageOutcome } from "../../../../src/engine/plugs/research/read-page";

const limits = { ...testLimits, maxRedirects: 3 };

const page = sendRoute({
  headers: { "Content-Type": "text/html" },
  body: readablePage,
});
const public4 = "93.184.216.34";
const public6 = "2606:4700::1111";
const nat64 = "64:ff9b::14cf:4952";

function redirectTo(location: string, headers = {}): FakeRoute {
  return sendRoute({
    status: 302,
    headers: { Location: location, ...headers },
  });
}

type ConnectionRow = {
  name: string;
  url: string;
  answers: [string, string[]][];
  routes: [string, FakeRoute][];
  lookups: string[];
  targets: Partial<ConnectTarget>[];
  host: string;
};

const connectionRows: ConnectionRow[] = [
  {
    name: "an IPv6-only answer is the target, without brackets",
    url: "http://v6.test/",
    answers: [["v6.test", [public6]]],
    routes: [["/", page]],
    lookups: ["v6.test"],
    targets: [{ address: public6, port: 80, tls: false }],
    host: "v6.test",
  },
  {
    name: "IPv4 is picked from a mixed-family answer",
    url: "http://both.test/",
    answers: [["both.test", [public6, public4]]],
    routes: [["/", page]],
    lookups: ["both.test"],
    targets: [{ address: public4 }],
    host: "both.test",
  },
  {
    name: "a NAT64 address carrying a public IPv4 is the target",
    url: "http://nat64.test/",
    answers: [["nat64.test", [nat64]]],
    routes: [["/", page]],
    lookups: ["nat64.test"],
    targets: [{ address: nat64 }],
    host: "nat64.test",
  },
  {
    name: "IPv4 is picked from a NAT64 and IPv4 answer",
    url: "http://nat64.test/",
    answers: [["nat64.test", [nat64, public4]]],
    routes: [["/", page]],
    lookups: ["nat64.test"],
    targets: [{ address: public4 }],
    host: "nat64.test",
  },
  {
    name: "a public NAT64 literal is connected to directly, with no servername",
    url: `https://[${nat64}]/`,
    answers: [],
    routes: [["/", page]],
    lookups: [],
    targets: [{ address: nat64, tls: true, port: 443, servername: null }],
    host: `[${nat64}]`,
  },
  {
    name: "the port follows the URL",
    url: "http://example.test:8080/",
    answers: [["example.test", [public4]]],
    routes: [["/", page]],
    lookups: ["example.test"],
    targets: [{ address: public4, port: 8080 }],
    host: "example.test:8080",
  },
  {
    name: "https connects with TLS on 443 and the name as servername",
    url: "https://example.test/",
    answers: [["example.test", [public4]]],
    routes: [["/", page]],
    lookups: ["example.test"],
    targets: [{ tls: true, port: 443, servername: "example.test" }],
    host: "example.test",
  },
  {
    name: "a trailing dot is stripped from the name everywhere",
    url: "http://example.test./",
    answers: [["example.test", [public4]]],
    routes: [["/", page]],
    lookups: ["example.test"],
    targets: [{ tls: false, port: 80, servername: null }],
    host: "example.test",
  },
  {
    name: "an http to https redirect switches each hop's transport",
    url: "http://plain.test/go",
    answers: [
      ["plain.test", [public4]],
      ["secure.test", [public4]],
    ],
    routes: [
      ["/go", redirectTo("https://secure.test/landing")],
      ["/landing", page],
    ],
    lookups: ["plain.test", "secure.test"],
    targets: [
      { tls: false, port: 80, servername: null },
      { tls: true, port: 443, servername: "secure.test" },
    ],
    host: "secure.test",
  },
  {
    name: "an https to http redirect switches each hop's transport",
    url: "https://secure.test/go",
    answers: [
      ["plain.test", [public4]],
      ["secure.test", [public4]],
    ],
    routes: [
      ["/go", redirectTo("http://plain.test/landing")],
      ["/landing", page],
    ],
    lookups: ["secure.test", "plain.test"],
    targets: [
      { tls: true, port: 443, servername: "secure.test" },
      { tls: false, port: 80, servername: null },
    ],
    host: "plain.test",
  },
];

type RedirectRow = {
  name: string;
  location: string;
  expected: Partial<PageOutcome>;
  connects: number;
};

const redirectRows: RedirectRow[] = [
  {
    name: "to a name resolving to a private address",
    location: "http://private.test/",
    expected: { ok: false, cause: "refused", rule: "privateAddress" },
    connects: 1,
  },
  {
    name: "to a private literal",
    location: "http://127.0.0.1/",
    expected: { ok: false, cause: "refused", rule: "privateAddress" },
    connects: 1,
  },
  {
    name: "to a blocked host",
    location: "http://x.com/",
    expected: { ok: false, cause: "refused", rule: "blockedHost" },
    connects: 1,
  },
  {
    name: "to Exa's API host",
    location: "https://api.exa.ai/contents",
    expected: { ok: false, cause: "refused", rule: "blockedHost" },
    connects: 1,
  },
  {
    name: "to a URL with credentials",
    location: "http://u:p@example.test/",
    expected: { ok: false, cause: "refused", rule: "credentials" },
    connects: 1,
  },
  {
    name: "to an unparseable Location",
    location: "http://[bad",
    expected: { ok: false, cause: "refused", rule: "scheme" },
    connects: 1,
  },
  {
    name: "to a relative Location",
    location: "/landing",
    expected: { ok: true },
    connects: 2,
  },
];

const chainRows: [number, Partial<PageOutcome>][] = [
  [3, { ok: true }],
  [4, { ok: false, cause: "refused", rule: "tooManyRedirects" }],
];

let network: FakeNetwork;

beforeEach(async () => {
  network = await startFakeNetwork();
  network.answer("example.test", [public4]);
  network.answer("private.test", ["10.0.0.5"]);
});

afterEach(async () => {
  await network.close();
});

function read(url: string, lookup: LookupAll = network.lookup) {
  return readThrough(network, url, { limits, lookup });
}

describe("readPage connections", () => {
  it.each(connectionRows)("$name", async (row) => {
    for (const [name, addresses] of row.answers)
      network.answer(name, addresses);
    for (const [path, route] of row.routes) network.route(path, route);
    const outcome = await read(row.url);
    expect(outcome.ok).toBe(true);
    expect(network.lookups).toEqual(row.lookups);
    expect(network.targets).toHaveLength(row.targets.length);
    row.targets.forEach((target, index) => {
      expect(network.targets[index]).toMatchObject(target);
    });
    expect(network.requests.at(-1)?.headers.host).toBe(row.host);
  });

  it("connects to the address it checked even when a second lookup would differ", async () => {
    let calls = 0;
    const rebinding: LookupAll = async () => {
      calls += 1;
      return calls === 1 ? [public4] : ["127.0.0.1"];
    };
    network.route("/", page);
    const outcome = await read("http://rebind.test/", rebinding);
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(1);
    expect(network.targets).toEqual([
      { address: public4, port: 80, servername: null, tls: false },
    ]);
  });
});

describe("readPage redirect targets", () => {
  it.each(redirectRows)("$name", async (row) => {
    network.route("/go", redirectTo(row.location));
    network.route("/landing", page);
    const outcome = await read("http://example.test/go");
    expect(outcome).toMatchObject(row.expected);
    expect(network.targets).toHaveLength(row.connects);
  });

  it.each(chainRows)(
    "follows a chain of %i redirects up to the limit",
    async (count, expected) => {
      network.route("/chain/0", page);
      for (let hop = 1; hop <= count; hop += 1) {
        network.route(`/chain/${hop}`, redirectTo(`/chain/${hop - 1}`));
      }
      const outcome = await read(`http://example.test/chain/${count}`);
      expect(outcome).toMatchObject(expected);
    },
  );
});

describe("readPage redirect responses", () => {
  it("treats a 3xx without Location as an HTTP error", async () => {
    network.route("/go", sendRoute({ status: 302 }));
    expect(await read("http://example.test/go")).toEqual({
      ok: false,
      cause: "httpError",
    });
  });

  it("drops a redirect whose body never ends without waiting for it", async () => {
    const endless = dripRoute({
      status: 301,
      headers: { Location: "/landing" },
      chunk: "x",
      everyMs: 50,
    });
    network.route("/go", endless.route);
    network.route("/landing", page);
    const started = Date.now();
    const outcome = await read("http://example.test/go");
    expect(outcome.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("never forwards a cookie a response set", async () => {
    network.route(
      "/go",
      redirectTo("/landing", { "Set-Cookie": "session=abc" }),
    );
    network.route("/landing", page);
    const outcome = await read("http://example.test/go");
    expect(outcome.ok).toBe(true);
    expect(network.requests).toHaveLength(2);
    for (const seen of network.requests) {
      expect(seen.headers.cookie).toBeUndefined();
    }
  });
});
