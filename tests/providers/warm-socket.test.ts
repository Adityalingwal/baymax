import { describe, expect, it } from "vitest";
import { createSocketHarness } from "./socket.harness";
import { startWarmSocket } from "../../src/providers/warm-socket";

function start() {
  const h = createSocketHarness();
  const seen: string[] = [];
  const socket = startWarmSocket(
    {
      url: "wss://example.test/x",
      protocols: ["token", "k"],
      openSocket: h.openSocket,
      setTimer: h.setTimer,
      log: () => undefined,
    },
    {
      opened: () => seen.push("opened"),
      received: (payload) => seen.push(`received ${String(payload)}`),
      closed: () => seen.push("closed"),
    },
  );
  return { h, seen, socket };
}

// The times at which each socket was opened, while every attempt fails.
function attemptTimes(failures: number) {
  const { h } = start();
  const times = [h.now()];
  for (let index = 0; index < failures; index += 1) {
    h.last().events.closed(1006, "");
    const before = h.sockets.length;
    while (h.sockets.length === before) h.advance(100);
    times.push(h.now());
  }
  return times;
}

describe("warm socket", () => {
  it("opens at start with the url and subprotocols, and sends only while open", () => {
    const { h, seen, socket } = start();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe("wss://example.test/x");
    expect(h.last().protocols).toEqual(["token", "k"]);
    expect(socket.send("early")).toBe(false);
    h.last().events.opened();
    expect(socket.isOpen()).toBe(true);
    expect(socket.send("hello")).toBe(true);
    h.last().events.received("reply");
    expect(h.last().sent).toEqual(["hello"]);
    expect(seen).toEqual(["opened", "received reply"]);
  });

  it("reconnects with backoff 0.5, 1, 2, 4, then at most 8 s", () => {
    expect(attemptTimes(6)).toEqual([0, 500, 1500, 3500, 7500, 15500, 23500]);
  });

  it("starts the backoff over after a socket opened", () => {
    const { h, seen } = start();
    h.last().events.closed(1006, "");
    h.advance(500);
    h.last().events.opened();
    h.last().events.closed(1000, "bye");
    h.advance(499);
    expect(h.sockets).toHaveLength(2);
    h.advance(1);
    expect(h.sockets).toHaveLength(3);
    expect(seen).toEqual(["opened", "closed"]);
  });
});

describe("warm socket control", () => {
  it("connects now instead of waiting out the backoff, once", () => {
    const { h, socket } = start();
    h.last().events.closed(1006, "");
    socket.connectNow();
    socket.connectNow();
    expect(h.sockets).toHaveLength(2);
    h.advance(10_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("ignores the events of a socket it already replaced", () => {
    const { h, seen } = start();
    const old = h.last();
    old.events.closed(1006, "");
    h.advance(500);
    old.events.opened();
    old.events.received("stale");
    old.events.closed(1006, "");
    expect(seen).toEqual([]);
    expect(h.sockets).toHaveLength(2);
  });

  it("stops: closes the socket and never reconnects", () => {
    const { h, socket } = start();
    h.last().events.opened();
    socket.stop();
    expect(h.last().closed).toBe(true);
    expect(socket.isOpen()).toBe(false);
    h.advance(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("restarts: closes the socket, tells the listener, connects a fresh one and ignores the old one", () => {
    const { h, seen, socket } = start();
    const old = h.last();
    old.events.opened();
    socket.restart();
    expect(old.closed).toBe(true);
    expect(h.sockets).toHaveLength(2);
    old.events.received("stale");
    old.events.closed(1000, "");
    h.last().events.opened();
    expect(seen).toEqual(["opened", "closed", "opened"]);
  });
});
