import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStubOutput } from "./playback.harness";
import { createWebAudioPlayer } from "../../src/renderer/web-audio";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

// Two 16-bit samples per chunk: 0x4000 is half of full scale.
const chunk = () => new Uint8Array([0x00, 0x40, 0x00, 0xc0]).buffer;

describe("the Web Audio player streams chunks", () => {
  it("schedules each chunk right after the one before on one timeline", () => {
    const stub = createStubOutput("running");
    stub.output.currentTime = 1;
    const player = createWebAudioPlayer(stub.createOutput);
    player.queue(chunk(), 4);
    player.queue(chunk(), 4);
    expect(stub.sources.map((source) => source.start.mock.calls[0])).toEqual([
      [1],
      [1.5],
    ]);
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
    expect(stub.sources[2].start).toHaveBeenCalledWith(0);
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
