import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStubOutput } from "./playback.harness";
import { speechStartBufferMs } from "../../src/shared/ipc";
import { createWebAudioPlayer } from "../../src/renderer/web-audio";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// Two 16-bit samples per chunk: 0x4000 is half of full scale.
const chunk = () => new Uint8Array([0x00, 0x40, 0x00, 0xc0]).buffer;

const buffer = speechStartBufferMs / 1000;

// 40 ms of 1 kHz audio: at speech level, or the silence Aura opens a line with.
const speech = () => new Int16Array(40).fill(0x4000).buffer;
const silence = () => new Int16Array(40).buffer;

const startOf = (stub: ReturnType<typeof createStubOutput>, index: number) =>
  (stub.sources[index].start.mock.calls[0] as number[])[0];

describe("the Web Audio player streams chunks", () => {
  it("starts a line after the start buffer and schedules each chunk right after the one before", () => {
    const stub = createStubOutput("running");
    stub.output.currentTime = 1;
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(chunk(), 4);
    player.queue(chunk(), 4);
    expect(startOf(stub, 0)).toBeCloseTo(1 + buffer);
    expect(startOf(stub, 1)).toBeCloseTo(1 + buffer + 0.5);
    expect([...stub.buffers[0]]).toEqual([0.5, -0.5]);
    expect(stub.createOutput).toHaveBeenCalledTimes(1);
  });

  it("calls the drained callback once, after the last queued chunk ended", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    const onDrained = vi.fn();
    player.queue(chunk(), 4);
    player.queue(chunk(), 4);
    player.whenDrained(onDrained);
    stub.sources[0].onended?.(new Event("ended"));
    expect(onDrained).not.toHaveBeenCalled();
    stub.sources[1].onended?.(new Event("ended"));
    stub.sources[1].onended?.(new Event("ended"));
    expect(onDrained).toHaveBeenCalledTimes(1);
  });
});

describe("the Web Audio player stops a stream", () => {
  it("stop() stops every queued chunk and forgets the drained callback", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    const onDrained = vi.fn();
    player.queue(chunk(), 4);
    player.queue(chunk(), 4);
    player.whenDrained(onDrained);
    player.stop();
    stub.sources.forEach((source) => source.onended?.(new Event("ended")));
    expect(stub.sources.map((source) => source.stop.mock.calls.length)).toEqual(
      [1, 1],
    );
    expect(onDrained).not.toHaveBeenCalled();
    player.queue(chunk(), 4);
    expect(startOf(stub, 2)).toBeCloseTo(buffer);
  });

  it("resumes a suspended output and drains at once with nothing queued", () => {
    const stub = createStubOutput("suspended");
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(chunk(), 4);
    expect(stub.output.resume).toHaveBeenCalledTimes(1);
    const idle = createWebAudioPlayer(createStubOutput("running").createOutput);
    const onDrained = vi.fn();
    idle.whenDrained(onDrained);
    expect(onDrained).toHaveBeenCalledTimes(1);
  });
});

describe("the Web Audio player's start buffer", () => {
  it("stays continuous across the measured burst gap", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    for (let burst = 0; burst < 5; burst += 1) player.queue(speech(), 1000);
    stub.output.currentTime = 0.514;
    for (let burst = 0; burst < 3; burst += 1) player.queue(speech(), 1000);
    stub.sources.forEach((_source, index) => {
      expect(startOf(stub, index)).toBeCloseTo(buffer + index * 0.04);
    });
  });

  it("plays a chunk at once after running dry, with no second buffer", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(speech(), 1000);
    stub.output.currentTime = 5;
    player.queue(speech(), 1000);
    expect(startOf(stub, 1)).toBe(5);
  });

  it("gives the next line its own buffer once a line has drained", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(speech(), 1000);
    player.whenDrained(vi.fn());
    stub.sources[0].onended?.(new Event("ended"));
    stub.output.currentTime = 5;
    player.queue(speech(), 1000);
    expect(startOf(stub, 1)).toBeCloseTo(5 + buffer);
  });
});

describe("the Web Audio player's lead silence", () => {
  it("drops it across chunks and keeps the buffer's start for the first speech", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(silence(), 1000);
    player.queue(silence(), 1000);
    player.queue(speech(), 1000);
    expect(stub.sources).toHaveLength(1);
    expect(startOf(stub, 0)).toBeCloseTo(buffer);
  });

  it("keeps silence once speech has started", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(speech(), 1000);
    player.queue(silence(), 1000);
    expect(stub.sources).toHaveLength(2);
  });

  it("drops no more than its limit of a long silence", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    for (let chunks = 0; chunks < 25; chunks += 1) {
      player.queue(silence(), 1000);
    }
    expect(stub.sources.length).toBeGreaterThan(0);
  });

  it("drains at once when a line was all lead silence", () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(silence(), 1000);
    const onDrained = vi.fn();
    player.whenDrained(onDrained);
    expect(onDrained).toHaveBeenCalledTimes(1);
  });
});
