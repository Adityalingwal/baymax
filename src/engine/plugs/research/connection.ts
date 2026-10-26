import type { ClientRequestArgs } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isPublicAddress } from "./address";
import type { CheckedUrl, RefusalRule } from "./url-rules";

export type LookupAll = (hostname: string) => Promise<string[]>; // every address the name resolves to
export type ConnectTarget = {
  address: string;
  port: number;
  servername: string | null;
  tls: boolean;
};
export type Connect = (target: ConnectTarget) => Duplex;

type OnCreate = (err: Error | null, socket?: Duplex) => void;
type ConnectionHook = (
  options: ClientRequestArgs,
  oncreate: (err: Error | null, socket: Duplex) => void,
) => undefined;

function refusalError(rule: RefusalRule): Error {
  return new Error(`refused: ${rule}`, { cause: { rule } });
}

export function refusalOf(err: unknown): RefusalRule | null {
  if (!(err instanceof Error)) return null;
  const cause: unknown = err.cause;
  if (typeof cause !== "object" || cause === null || !("rule" in cause)) {
    return null;
  }
  return cause.rule === "privateAddress" ? "privateAddress" : null;
}

// The lookup takes no signal, so the read's signal ends the wait instead.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function addressFor(
  checked: CheckedUrl,
  lookup: LookupAll,
  signal: AbortSignal,
): Promise<string> {
  if (checked.literal) return checked.hostname;
  const addresses = await untilAborted(lookup(checked.hostname), signal);
  if (addresses.length === 0) throw new Error("no address for the name");
  if (!addresses.every(isPublicAddress)) throw refusalError("privateAddress");
  return addresses.find((address) => isIP(address) === 4) ?? addresses[0];
}

async function openSocket(
  checked: CheckedUrl,
  deps: { lookup: LookupAll; connect: Connect },
  signal: AbortSignal,
): Promise<Duplex> {
  const address = await addressFor(checked, deps.lookup, signal);
  signal.throwIfAborted();
  const servername = checked.tls && !checked.literal ? checked.hostname : null;
  return deps.connect({
    address,
    port: checked.port,
    servername,
    tls: checked.tls,
  });
}

// Node treats a truthy return as the socket, so the hook returns undefined and calls back once.
export function createGuardedConnection(
  checked: CheckedUrl,
  deps: { lookup: LookupAll; connect: Connect },
  signal: AbortSignal,
): ConnectionHook {
  return (_options, oncreate) => {
    // Node ignores the socket argument when an error is passed.
    const done = oncreate as OnCreate;
    let settled = false;
    const finish = (err: Error | null, socket?: Duplex) => {
      if (settled) return;
      settled = true;
      done(err, socket);
    };
    openSocket(checked, deps, signal)
      .then((socket) => finish(null, socket))
      .catch((err: unknown) =>
        finish(err instanceof Error ? err : new Error(String(err))),
      );
    return undefined;
  };
}
