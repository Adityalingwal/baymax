import type { OpenSocket, SocketEvents, SocketPayload } from "./warm-socket";

export type FakeSocket = {
  url: string;
  protocols: string[];
  events: SocketEvents;
  sent: SocketPayload[];
  closed: boolean;
};

type Timer = { at: number; fire: () => void };

// Every socket the code opens, and a clock whose timers fire only when a test advances it.
export function createSocketHarness() {
  const sockets: FakeSocket[] = [];
  const openSocket: OpenSocket = (url, protocols, events) => {
    const socket: FakeSocket = {
      url,
      protocols,
      events,
      sent: [],
      closed: false,
    };
    sockets.push(socket);
    return {
      send: (payload) => socket.sent.push(payload),
      close: () => {
        socket.closed = true;
      },
    };
  };
  let now = 0;
  let timers: Timer[] = [];
  const setTimer = (ms: number, fire: () => void) => {
    const timer = { at: now + ms, fire };
    timers.push(timer);
    return () => {
      timers = timers.filter((other) => other !== timer);
    };
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      timers = timers.filter((timer) => timer !== due[0]);
      now = due[0].at;
      due[0].fire();
    }
    now = target;
  };
  const last = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("no socket opened");
    return socket;
  };
  return { sockets, openSocket, setTimer, advance, last, now: () => now };
}

// A sent payload as text: JSON as is, binary as its byte count and whether it is all zeros.
export function describeSent(payload: SocketPayload): string {
  if (typeof payload === "string") return payload;
  const bytes = new Uint8Array(payload);
  const zeros = bytes.every((byte) => byte === 0);
  return `${zeros ? "zeros" : "audio"} ${bytes.byteLength}`;
}
