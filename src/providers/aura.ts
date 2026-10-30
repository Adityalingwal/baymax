import { startWarmSocket } from "./warm-socket";
import type { OpenSocket, SetTimer, SocketPayload } from "./warm-socket";

export type AuraEvent =
  | { kind: "audio"; pcm: ArrayBuffer }
  | { kind: "flushed" }
  | { kind: "other"; summary: string };

export type AuraListener = {
  heard: (event: AuraEvent) => void;
  closed: () => void;
};

export type Aura = {
  isOpen: () => boolean;
  speak: (text: string) => boolean;
  flush: () => boolean;
  restart: () => void; // a fresh socket, so no audio of a cut line can reach the next one
  stop: () => void;
};

export type AuraParams = {
  key: string;
  openSocket: OpenSocket;
  setTimer: SetTimer;
  log: (message: string) => void;
};

// Aura-2 sends raw 24 kHz 16-bit mono PCM in many small binary messages.
export const auraSampleRate = 24_000;

const auraUrl =
  "wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readAuraMessage(payload: SocketPayload): AuraEvent {
  if (typeof payload !== "string") return { kind: "audio", pcm: payload };
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return { kind: "other", summary: "not JSON" };
  }
  if (!isRecord(message)) return { kind: "other", summary: "not an object" };
  if (message.type === "Flushed") return { kind: "flushed" };
  return { kind: "other", summary: String(message.type) };
}

// One warm Aura-2 socket; text goes in as Speak messages, and each Flush ends with one Flushed.
// Chunks carry no line id, so a cut line restarts the socket instead of sending Clear.
export function startAura(params: AuraParams, listener: AuraListener): Aura {
  const socket = startWarmSocket(
    {
      url: auraUrl,
      protocols: ["token", params.key],
      openSocket: params.openSocket,
      setTimer: params.setTimer,
      log: params.log,
    },
    {
      opened: () => params.log("speech socket open"),
      received: (payload) => listener.heard(readAuraMessage(payload)),
      closed: listener.closed,
    },
  );
  const send = (message: object) => socket.send(JSON.stringify(message));
  return {
    isOpen: socket.isOpen,
    speak: (text) => send({ type: "Speak", text }),
    flush: () => send({ type: "Flush" }),
    restart: socket.restart,
    stop: socket.stop,
  };
}
