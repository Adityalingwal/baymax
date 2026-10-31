import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { addAbortSignal } from "node:stream";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip } from "node:zlib";

export type BodyEncoding = "identity" | "gzip" | "br";

type Keeper = {
  add: (chunk: Buffer) => void;
  full: () => boolean;
  bytes: () => Buffer;
};

function createKeeper(maxBytes: number): Keeper {
  const parts: Buffer[] = [];
  let size = 0;
  return {
    add: (chunk) => {
      const room = maxBytes - size;
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      parts.push(part);
      size += part.length;
    },
    full: () => size >= maxBytes,
    bytes: () => Buffer.concat(parts),
  };
}

function decompressionError(cause: unknown): Error {
  return new Error("the body could not be decompressed", {
    cause: { decompression: true, error: cause },
  });
}

export function isDecompressionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause: unknown = err.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "decompression" in cause &&
    cause.decompression === true
  );
}

async function collect(
  source: AsyncIterable<Buffer>,
  kept: Keeper,
): Promise<void> {
  for await (const chunk of source) {
    kept.add(chunk);
    if (kept.full()) break;
  }
}

type Budget = { maxBytes: number; hit: boolean };

async function* capped(
  source: AsyncIterable<Buffer>,
  budget: Budget,
): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const chunk of source) {
    const part = chunk.subarray(0, budget.maxBytes - total);
    total += part.length;
    yield part;
    if (total >= budget.maxBytes) {
      budget.hit = true;
      return;
    }
  }
}

function createDecompressor(encoding: "gzip" | "br"): Transform {
  return encoding === "gzip" ? createGunzip() : createBrotliDecompress();
}

async function readCompressed(
  response: IncomingMessage,
  decompressor: Transform,
  kept: Keeper,
  maxBytes: number,
): Promise<boolean> {
  const budget: Budget = { maxBytes, hit: false };
  let origin: "network" | "decompression" | null = null;
  response.on("error", () => (origin ??= "network"));
  decompressor.on("error", () => (origin ??= "decompression"));
  // Errors on any stage also end the loop below, which reports them.
  pipeline(
    response,
    (source: AsyncIterable<Buffer>) => capped(source, budget),
    decompressor,
  ).catch(() => undefined);
  try {
    await collect(decompressor, kept);
    return budget.hit;
  } catch (err) {
    // A body cut at the encoded budget ends mid-stream; what was decoded before the cut is kept.
    if (budget.hit) return true;
    throw origin === "decompression" ? decompressionError(err) : err;
  }
}

export async function readBody(
  response: IncomingMessage,
  encoding: BodyEncoding,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; cut: boolean }> {
  const kept = createKeeper(maxBytes);
  let hitBudget = false;
  if (encoding === "identity") {
    await collect(response, kept);
  } else {
    const decompressor = addAbortSignal(signal, createDecompressor(encoding));
    try {
      hitBudget = await readCompressed(response, decompressor, kept, maxBytes);
    } finally {
      decompressor.destroy();
      response.destroy();
    }
  }
  signal.throwIfAborted();
  return { bytes: kept.bytes(), cut: hitBudget || kept.full() };
}

export function decodeText(bytes: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
