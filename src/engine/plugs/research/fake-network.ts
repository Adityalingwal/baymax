import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Connect, ConnectTarget, LookupAll } from "./connection";

// Test support only: a real local HTTP server behind a fake DNS lookup and a fake connection.

export type FakeRoute = (req: IncomingMessage, res: ServerResponse) => void;
export type SeenRequest = { path: string; headers: IncomingHttpHeaders };
export type FakeNetwork = {
  route: (path: string, route: FakeRoute) => void;
  answer: (hostname: string, addresses: string[]) => void;
  lookup: LookupAll;
  lookups: string[];
  connect: Connect;
  targets: ConnectTarget[];
  requests: SeenRequest[];
  close: () => Promise<void>;
};
export type DripRoute = {
  route: FakeRoute;
  written: () => number;
  closedEarly: () => boolean;
};

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function notFound(): Error {
  return Object.assign(new Error("getaddrinfo ENOTFOUND"), {
    code: "ENOTFOUND",
  });
}

export async function startFakeNetwork(): Promise<FakeNetwork> {
  const routes = new Map<string, FakeRoute>();
  const answers = new Map<string, string[]>();
  const lookups: string[] = [];
  const targets: ConnectTarget[] = [];
  const requests: SeenRequest[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push({ path, headers: req.headers });
    res.on("error", () => undefined);
    const route = routes.get(path);
    if (route === undefined) res.writeHead(404).end("not found");
    else route(req, res);
  });
  const port = await listen(server);
  return {
    route: (path, route) => routes.set(path, route),
    answer: (hostname, addresses) => answers.set(hostname, addresses),
    lookup: async (hostname) => {
      lookups.push(hostname);
      const addresses = answers.get(hostname);
      if (addresses === undefined) throw notFound();
      return addresses;
    },
    lookups,
    connect: (target) => {
      targets.push(target);
      return netConnect(port, "127.0.0.1");
    },
    targets,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function htmlPage(title: string, body: string): string {
  return `<html><head><title>${title}</title></head><body>${body}</body></html>`;
}

export const readablePage = htmlPage(
  "Example page",
  `<p>${"Plain words for a reader to keep. ".repeat(10)}</p>`,
);

export function sendRoute(params: {
  status?: number;
  headers?: OutgoingHttpHeaders;
  body?: Buffer | string;
}): FakeRoute {
  return (_req, res) => {
    res.writeHead(params.status ?? 200, params.headers ?? {});
    res.end(params.body ?? "");
  };
}

// Writes a chunk on an interval until total bytes are written (then ends) or the client goes away.
export function dripRoute(params: {
  status?: number;
  headers?: OutgoingHttpHeaders;
  chunk: Buffer | string;
  everyMs: number;
  total?: number;
}): DripRoute {
  let written = 0;
  let closedEarly = false;
  const route: FakeRoute = (_req, res) => {
    res.writeHead(params.status ?? 200, params.headers ?? {});
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write(params.chunk);
      written += Buffer.byteLength(params.chunk);
      if (params.total !== undefined && written >= params.total) res.end();
    }, params.everyMs);
    res.on("close", () => {
      clearInterval(timer);
      closedEarly = !res.writableFinished;
    });
  };
  return { route, written: () => written, closedEarly: () => closedEarly };
}

// A port with nothing listening: a throwaway server is started and closed.
export async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
