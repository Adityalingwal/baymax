import { describe, expect, it } from "vitest";
import { toPcm16 } from "./pcm";

function samplesOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer);
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) =>
    view.getInt16(index * 2, true),
  );
}

type Row = {
  name: string;
  input: number[];
  fromRate: number;
  start: number;
  samples: number[];
  next: number;
};

const rows: Row[] = [
  {
    name: "16 kHz passes through, scaled to 16-bit",
    input: [0, 0.5, -0.5, 1, -1],
    fromRate: 16_000,
    start: 0,
    samples: [0, 16383, -16384, 32767, -32768],
    next: 0,
  },
  {
    name: "values past full scale are clipped",
    input: [2, -3],
    fromRate: 16_000,
    start: 0,
    samples: [32767, -32768],
    next: 0,
  },
  {
    name: "48 kHz averages each three samples into one",
    input: [0.3, 0.3, 0.3, -0.6, 0, 0],
    fromRate: 48_000,
    start: 0,
    samples: [9830, -6553],
    next: 0,
  },
  {
    name: "48 kHz carries a block's leftover into the next block",
    input: [0.6, 0.6, 0.6, 0.3],
    fromRate: 48_000,
    start: 0,
    samples: [19660, 9830],
    next: 2,
  },
  {
    name: "a carried start skips the samples the last block already used",
    input: [1, 1, 0.3, 0.3, 0.3],
    fromRate: 48_000,
    start: 2,
    samples: [9830],
    next: 0,
  },
  {
    name: "an empty block gives no samples",
    input: [],
    fromRate: 48_000,
    start: 0,
    samples: [],
    next: 0,
  },
];

describe("PCM conversion to 16 kHz 16-bit", () => {
  it.each(rows)("$name", ({ input, fromRate, start, samples, next }) => {
    const result = toPcm16(Float32Array.from(input), fromRate, start);
    expect(samplesOf(result.bytes)).toEqual(samples);
    expect(result.next).toBeCloseTo(next);
  });

  it("44.1 kHz gives one sample per 2.75625 input samples across uneven blocks", () => {
    let start = 0;
    let total = 0;
    for (const size of [128, 128, 128, 60]) {
      const result = toPcm16(new Float32Array(size), 44_100, start);
      start = result.next;
      total += result.bytes.byteLength / 2;
    }
    expect(total).toBe(162);
  });
});
