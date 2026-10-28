export type SocketPayload = string | ArrayBuffer;

export type SocketEvents = {
  opened: () => void;
  received: (payload: SocketPayload) => void;
  closed: (code: number, reason: string) => void;
};

export type Socket = {
  send: (payload: SocketPayload) => void;
  close: () => void;
};

// Injected so the voice sockets run offline in tests; events never fire inside the call itself.
export type OpenSocket = (
  url: string,
  protocols: string[],
  events: SocketEvents,
) => Socket;

export type SetTimer = (ms: number, fire: () => void) => () => void;

export type WarmSocketParams = {
  url: string;
  protocols: string[];
  openSocket: OpenSocket;
  setTimer: SetTimer;
  log: (message: string) => void;
};

export type WarmSocketListener = {
  opened: () => void;
  received: (payload: SocketPayload) => void;
  closed: () => void;
};

export type WarmSocket = {
  isOpen: () => boolean;
  send: (payload: SocketPayload) => boolean;
  connectNow: () => void;
  stop: () => void;
};

type Connection = { socket: Socket | null; open: boolean };

type State = {
  connection: Connection | null;
  attempt: number;
  cancelRetry: (() => void) | null;
  stopped: boolean;
};

const backoffMs = [500, 1000, 2000, 4000, 8000];

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function cancelRetry(state: State): void {
  const cancel = state.cancelRetry;
  state.cancelRetry = null;
  cancel?.();
}

function lost(
  state: State,
  params: WarmSocketParams,
  listener: WarmSocketListener,
  why: string,
): void {
  const wasOpen = state.connection?.open ?? false;
  state.connection = null;
  params.log(`socket closed: ${why}`);
  if (wasOpen) listener.closed();
  if (state.stopped) return;
  const ms = backoffMs[Math.min(state.attempt, backoffMs.length - 1)];
  state.attempt += 1;
  state.cancelRetry = params.setTimer(ms, () => {
    state.cancelRetry = null;
    connect(state, params, listener);
  });
}

function connect(
  state: State,
  params: WarmSocketParams,
  listener: WarmSocketListener,
): void {
  if (state.stopped || state.connection !== null) return;
  cancelRetry(state);
  const connection: Connection = { socket: null, open: false };
  state.connection = connection;
  const current = () => state.connection === connection;
  try {
    connection.socket = params.openSocket(params.url, params.protocols, {
      opened: () => {
        if (!current()) return;
        connection.open = true;
        state.attempt = 0;
        listener.opened();
      },
      received: (payload) => {
        if (current() && connection.open) listener.received(payload);
      },
      closed: (code, reason) => {
        if (current()) lost(state, params, listener, `${code} ${reason}`);
      },
    });
  } catch (error) {
    if (current()) lost(state, params, listener, describeError(error));
  }
}

function send(state: State, payload: SocketPayload): boolean {
  const connection = state.connection;
  if (connection === null || !connection.open || connection.socket === null) {
    return false;
  }
  try {
    connection.socket.send(payload);
    return true;
  } catch {
    return false;
  }
}

function stop(state: State): void {
  state.stopped = true;
  cancelRetry(state);
  const socket = state.connection?.socket ?? null;
  state.connection = null;
  try {
    socket?.close();
  } catch {
    // Closing a socket that already failed has nothing left to release.
  }
}

// One socket kept open from app start: a close reconnects with backoff, and connectNow skips the wait.
export function startWarmSocket(
  params: WarmSocketParams,
  listener: WarmSocketListener,
): WarmSocket {
  const state: State = {
    connection: null,
    attempt: 0,
    cancelRetry: null,
    stopped: false,
  };
  connect(state, params, listener);
  return {
    isOpen: () => state.connection?.open ?? false,
    send: (payload) => send(state, payload),
    connectNow: () => connect(state, params, listener),
    stop: () => stop(state),
  };
}

export const openWebSocket: OpenSocket = (url, protocols, events) => {
  const socket = new WebSocket(url, protocols);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => events.opened();
  socket.onmessage = (message: MessageEvent<unknown>) => {
    const payload = message.data;
    if (typeof payload === "string" || payload instanceof ArrayBuffer) {
      events.received(payload);
    }
  };
  socket.onclose = (event) => events.closed(event.code, event.reason);
  return {
    send: (payload) => socket.send(payload),
    close: () => socket.close(),
  };
};
