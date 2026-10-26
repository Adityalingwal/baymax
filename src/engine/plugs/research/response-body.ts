import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import type { Transform } from "node:stream";
import { constants, createBrotliDecompress, createGunzip } from "node:zlib";

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

async function readPlain(
  response: IncomingMessage,
  kept: Keeper,
): Promise<void> {
  for await (const chunk of response) {
    kept.add(chunk as Buffer);
    if (kept.full()) break;
  }
}

async function* capped(
  source: AsyncIterable<Buffer>,
  maxBytes: number,
): AsyncGenerator<Buffer> {
  let total = 0;
  for await (const chunk of source) {
    const part = chunk.subarray(0, maxBytes - total);
    total += part.length;
    yield part;
    if (total >= maxBytes) return;
  }
}

// A sync finish flush lets a stream cut at the encoded budget end without an error.
function createDecompressor(encoding: "gzip" | "br"): Transform {
  return encoding === "gzip"
    ? createGunzip({ finishFlush: constants.Z_SYNC_FLUSH })
    : createBrotliDecompress({ finishFlush: constants.BROTLI_OPERATION_FLUSH });
}

async function readCompressed(
  response: IncomingMessage,
  decompressor: Transform,
  kept: Keeper,
  maxBytes: number,
): Promise<void> {
  let origin: "network" | "decompression" | null = null;
  response.on("error", () => (origin ??= "network"));
  decompressor.on("error", () => (origin ??= "decompression"));
  // Errors on any stage also end the loop below, which reports them.
  pipeline(
    response,
    (source: AsyncIterable<Buffer>) => capped(source, maxBytes),
    decompressor,
  ).catch(() => undefined);
  try {
    for await (const chunk of decompressor) {
      kept.add(chunk as Buffer);
      if (kept.full()) break;
    }
  } catch (err) {
    throw origin === "decompression" ? decompressionError(err) : err;
  }
}

// Reads at most maxBytes off the socket and keeps at most maxBytes decoded; a stop at a budget is not an error.
export async function readBody(
  response: IncomingMessage,
  encoding: BodyEncoding,
  maxBytes: number,
): Promise<Buffer> {
  const kept = createKeeper(maxBytes);
  if (encoding === "identity") {
    await readPlain(response, kept);
    return kept.bytes();
  }
  const decompressor = createDecompressor(encoding);
  try {
    await readCompressed(response, decompressor, kept, maxBytes);
  } finally {
    decompressor.destroy();
    response.destroy();
  }
  return kept.bytes();
}

export function decodeText(bytes: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
