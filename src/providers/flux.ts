import { startWarmSocket } from "./warm-socket";
import type { OpenSocket, SetTimer, SocketPayload } from "./warm-socket";

export type FluxEvent =
  | { kind: "update"; transcript: string }
  | { kind: "endOfTurn"; trigger: string; transcript: string }
  | { kind: "noActiveTurn" }
  | { kind: "other"; summary: string };

export type FluxListener = {
  opened: () => void;
  heard: (event: FluxEvent) => void;
  closed: () => void;
};

export type Flux = {
  isOpen: () => boolean;
  sendAudio: (pcm: ArrayBuffer) => boolean;
  endTurn: () => boolean;
  connectNow: () => void;
  stop: () => void;
};

export type FluxParams = {
  key: string;
  openSocket: OpenSocket;
  setTimer: SetTimer;
  log: (message: string) => void;
};

// eot_threshold=1.0 keeps Flux from ending a turn on a pause; eot_timeout_ms is the 60 s backstop.
const fluxUrl =
  "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=1.0&eot_timeout_ms=60000";
const keepAliveMs = 5000;
// Flux closes the socket on a KeepAlive message, so silence keeps it open: 100 ms of 16 kHz 16-bit PCM.
const keepAliveBytes = 3200;
// Without 200 ms of silence before ForceEndTurn the final sometimes came seconds late.
const endSilenceBytes = 6400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readTurnInfo(message: Record<string, unknown>): FluxEvent {
  const transcript = text(message.transcript);
  if (message.event === "Update") return { kind: "update", transcript };
  if (message.event === "EndOfTurn") {
    return { kind: "endOfTurn", trigger: text(message.trigger), transcript };
  }
  return { kind: "other", summary: `TurnInfo ${text(message.event)}` };
}

export function readFluxMessage(payload: SocketPayload): FluxEvent {
  if (typeof payload !== "string") return { kind: "other", summary: "binary" };
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return { kind: "other", summary: "not JSON" };
  }
  if (!isRecord(message)) return { kind: "other", summary: "not an object" };
  if (message.type === "TurnInfo") return readTurnInfo(message);
  const code = text(message.code);
  if (message.type === "Warning" && code === "FORCE_END_TURN_NO_ACTIVE_TURN") {
    return { kind: "noActiveTurn" };
  }
  return { kind: "other", summary: `${text(message.type)} ${code}`.trim() };
}

// One warm Flux socket; any send re-arms the keep-alive, so silence goes out only while nothing else does.
export function startFlux(params: FluxParams, listener: FluxListener): Flux {
  let cancelKeepAlive = (): void => undefined;
  const send = (payload: SocketPayload): boolean => {
    const sent = socket.send(payload);
    if (sent) armKeepAlive();
    return sent;
  };
  const armKeepAlive = (): void => {
    cancelKeepAlive();
    cancelKeepAlive = params.setTimer(keepAliveMs, () => {
      send(new ArrayBuffer(keepAliveBytes));
    });
  };
  const socket = startWarmSocket(
    {
      url: fluxUrl,
      protocols: ["token", params.key],
      openSocket: params.openSocket,
      setTimer: params.setTimer,
      log: params.log,
    },
    {
      opened: () => {
        armKeepAlive();
        listener.opened();
      },
      received: (payload) => listener.heard(readFluxMessage(payload)),
      closed: () => {
        cancelKeepAlive();
        listener.closed();
      },
    },
  );
  return {
    isOpen: socket.isOpen,
    sendAudio: send,
    endTurn: () =>
      send(new ArrayBuffer(endSilenceBytes)) &&
      send(JSON.stringify({ type: "ForceEndTurn" })),
    connectNow: socket.connectNow,
    stop: () => {
      cancelKeepAlive();
      socket.stop();
    },
  };
}
