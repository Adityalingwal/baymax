import { describe, expect, it } from "vitest";
import { startFlux } from "./flux";
import type { FluxEvent } from "./flux";
import { createSocketHarness, describeSent } from "./socket.harness";

function start() {
  const h = createSocketHarness();
  const seen: string[] = [];
  const events: FluxEvent[] = [];
  const flux = startFlux(
    {
      key: "dg-key",
      openSocket: h.openSocket,
      setTimer: h.setTimer,
      log: () => undefined,
    },
    {
      opened: () => seen.push("opened"),
      heard: (event) => {
        seen.push(event.kind);
        events.push(event);
      },
      closed: () => seen.push("closed"),
    },
  );
  const sent = () => h.last().sent.map(describeSent);
  return { h, seen, events, flux, sent };
}

const messageRows: { name: string; payload: string; event: FluxEvent }[] = [
  {
    name: "an update",
    payload: JSON.stringify({
      type: "TurnInfo",
      event: "Update",
      transcript: "what is",
    }),
    event: { kind: "update", transcript: "what is" },
  },
  {
    name: "a manual end of turn",
    payload: JSON.stringify({
      type: "TurnInfo",
      event: "EndOfTurn",
      trigger: "manual",
      transcript: "what is the weather",
    }),
    event: {
      kind: "endOfTurn",
      trigger: "manual",
      transcript: "what is the weather",
    },
  },
  {
    name: "a timeout end of turn",
    payload: JSON.stringify({
      type: "TurnInfo",
      event: "EndOfTurn",
      trigger: "timeout",
      transcript: "first part",
    }),
    event: { kind: "endOfTurn", trigger: "timeout", transcript: "first part" },
  },
  {
    name: "the no-active-turn warning",
    payload: JSON.stringify({
      type: "Warning",
      code: "FORCE_END_TURN_NO_ACTIVE_TURN",
    }),
    event: { kind: "noActiveTurn" },
  },
  {
    name: "another warning",
    payload: JSON.stringify({ type: "Warning", code: "SOMETHING" }),
    event: { kind: "other", summary: "Warning SOMETHING" },
  },
  {
    name: "a start of turn",
    payload: JSON.stringify({ type: "TurnInfo", event: "StartOfTurn" }),
    event: { kind: "other", summary: "TurnInfo StartOfTurn" },
  },
  {
    name: "connected metadata",
    payload: JSON.stringify({ type: "Connected" }),
    event: { kind: "other", summary: "Connected" },
  },
  {
    name: "text that is not JSON",
    payload: "{oops",
    event: { kind: "other", summary: "not JSON" },
  },
];

describe("Flux messages", () => {
  it.each(messageRows)("reads $name", ({ payload, event }) => {
    const { h, events } = start();
    h.last().events.opened();
    h.last().events.received(payload);
    expect(events[0]).toEqual(event);
  });
});

describe("Flux socket", () => {
  it("opens the listen URL with the key as a subprotocol", () => {
    const { h } = start();
    expect(h.last().url).toBe(
      "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=1.0&eot_timeout_ms=60000",
    );
    expect(h.last().protocols).toEqual(["token", "dg-key"]);
  });

  it("ends a turn with 200 ms of zero PCM and then ForceEndTurn", () => {
    const { h, flux, sent } = start();
    h.last().events.opened();
    flux.sendAudio(new Uint8Array([1, 2]).buffer);
    expect(flux.endTurn()).toBe(true);
    expect(sent()).toEqual([
      "audio 2",
      "zeros 6400",
      JSON.stringify({ type: "ForceEndTurn" }),
    ]);
  });
});

describe("Flux keep-alive (L3)", () => {
  it("keeps an idle socket alive with 100 ms of zero PCM every 5 s, never a KeepAlive message", () => {
    const { h, sent } = start();
    h.last().events.opened();
    h.advance(4999);
    expect(sent()).toEqual([]);
    h.advance(1);
    h.advance(5000);
    expect(sent()).toEqual(["zeros 3200", "zeros 3200"]);
  });

  it("sends no keep-alive while audio flows, nor after the socket closed", () => {
    const { h, flux, sent, seen } = start();
    h.last().events.opened();
    for (let index = 0; index < 10; index += 1) {
      h.advance(4000);
      flux.sendAudio(new Uint8Array([1]).buffer);
    }
    expect(sent().filter((text) => text.startsWith("zeros"))).toEqual([]);
    const first = h.last();
    first.events.closed(1006, "");
    h.advance(5000);
    expect(first.sent).toHaveLength(10);
    expect(seen).toEqual(["opened", "closed"]);
  });

  it("passes received messages on as events", () => {
    const { h, seen } = start();
    h.last().events.opened();
    h.last().events.received(messageRows[0].payload);
    expect(seen).toEqual(["opened", "update"]);
  });
});
