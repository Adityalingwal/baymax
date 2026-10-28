import { describe, expect, it } from "vitest";
import { readAuraMessage, startAura } from "./aura";
import type { AuraEvent } from "./aura";
import { createSocketHarness, describeSent } from "./socket.harness";

function start() {
  const h = createSocketHarness();
  const seen: AuraEvent[] = [];
  const closes: string[] = [];
  const aura = startAura(
    {
      key: "dg-key",
      openSocket: h.openSocket,
      setTimer: h.setTimer,
      log: () => undefined,
    },
    { heard: (event) => seen.push(event), closed: () => closes.push("closed") },
  );
  return { h, seen, closes, aura };
}

const pcm = new Uint8Array([1, 2]).buffer;

const messageRows: {
  name: string;
  payload: string | ArrayBuffer;
  event: AuraEvent;
}[] = [
  { name: "binary audio", payload: pcm, event: { kind: "audio", pcm } },
  {
    name: "a Flushed message",
    payload: JSON.stringify({ type: "Flushed", sequence_id: 0 }),
    event: { kind: "flushed" },
  },
  {
    name: "metadata",
    payload: JSON.stringify({ type: "Metadata", request_id: "r" }),
    event: { kind: "other", summary: "Metadata" },
  },
  {
    name: "text that is not JSON",
    payload: "{oops",
    event: { kind: "other", summary: "not JSON" },
  },
];

describe("Aura messages", () => {
  it.each(messageRows)("reads $name", ({ payload, event }) => {
    expect(readAuraMessage(payload)).toEqual(event);
  });
});

describe("Aura socket", () => {
  it("opens the speak URL for 24 kHz linear16 with the key as a subprotocol", () => {
    const { h } = start();
    expect(h.last().url).toBe(
      "wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000",
    );
    expect(h.last().protocols).toEqual(["token", "dg-key"]);
  });

  it("sends Speak, Flush and Clear as JSON only while open", () => {
    const { h, aura } = start();
    expect(aura.speak("early")).toBe(false);
    h.last().events.opened();
    aura.speak("Hello there.");
    aura.flush();
    aura.clear();
    expect(h.last().sent.map(describeSent)).toEqual([
      JSON.stringify({ type: "Speak", text: "Hello there." }),
      JSON.stringify({ type: "Flush" }),
      JSON.stringify({ type: "Clear" }),
    ]);
  });

  it("passes on received messages and a close", () => {
    const { h, seen, closes } = start();
    h.last().events.opened();
    h.last().events.received(pcm);
    h.last().events.closed(1006, "");
    expect(seen).toEqual([{ kind: "audio", pcm }]);
    expect(closes).toEqual(["closed"]);
  });
});
