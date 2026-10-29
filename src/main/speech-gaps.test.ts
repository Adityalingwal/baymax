import { describe, expect, it } from "vitest";
import { createGapWatch } from "./speech-gaps";

// 4,800 bytes of 16-bit mono at 24 kHz is 100 ms of audio.
const chunk = (lineId: string, seq: number, ms: number) => ({
  lineId,
  seq,
  pcm: new ArrayBuffer(ms * 48),
  sampleRate: 24_000,
});

type Arrival = { at: number; lineId: string; seq: number; ms: number };

const rows: { name: string; arrivals: Arrival[]; logs: string[] }[] = [
  {
    name: "chunks that arrive before the audio runs out",
    arrivals: [
      { at: 0, lineId: "a", seq: 0, ms: 500 },
      { at: 400, lineId: "a", seq: 1, ms: 500 },
      { at: 950, lineId: "a", seq: 2, ms: 500 },
    ],
    logs: [],
  },
  {
    name: "a chunk that comes after the audio ran out",
    arrivals: [
      { at: 0, lineId: "a", seq: 0, ms: 500 },
      { at: 800, lineId: "a", seq: 1, ms: 500 },
    ],
    logs: ["speech gap: audio ran dry 300 ms before chunk 1"],
  },
  {
    name: "a shortfall under the limit",
    arrivals: [
      { at: 0, lineId: "a", seq: 0, ms: 500 },
      { at: 590, lineId: "a", seq: 1, ms: 500 },
    ],
    logs: [],
  },
  {
    name: "a later chunk measured from where playback resumed",
    arrivals: [
      { at: 0, lineId: "a", seq: 0, ms: 500 },
      { at: 800, lineId: "a", seq: 1, ms: 500 },
      { at: 1250, lineId: "a", seq: 2, ms: 500 },
    ],
    logs: ["speech gap: audio ran dry 300 ms before chunk 1"],
  },
  {
    name: "a new line that starts fresh",
    arrivals: [
      { at: 0, lineId: "a", seq: 0, ms: 100 },
      { at: 5000, lineId: "b", seq: 0, ms: 500 },
    ],
    logs: [],
  },
];

describe("speech gap watch", () => {
  it.each(rows)("logs $name", ({ arrivals, logs }) => {
    let now = 0;
    const logged: string[] = [];
    const watch = createGapWatch(
      () => now,
      (message) => logged.push(message),
    );
    for (const arrival of arrivals) {
      now = arrival.at;
      watch(chunk(arrival.lineId, arrival.seq, arrival.ms));
    }
    expect(logged).toEqual(logs);
  });
});
