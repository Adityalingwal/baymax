import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };
export type Respond = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export const startServer = async (respond: Respond) => {
  const seen: Seen[] = [];
  let markSeen: () => void = () => undefined;
  const firstSeen = new Promise<void>((resolve) => (markSeen = resolve));
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", headers: request.headers, body });
      markSeen();
      respond(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the test server has no port");
  }
  const { port } = address;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, seen, firstSeen, stop };
};

export const localFetch = (port: number): typeof fetch => {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    url.protocol = "http:";
    url.host = `127.0.0.1:${port}`;
    return fetch(url, init);
  };
};

export const request = {
  model: "claude-sonnet-5-5",
  max_tokens: 16,
  messages: [{ role: "user" as const, content: "hi" }],
};

export const destroySocket: Respond = (request) => request.socket.destroy();
