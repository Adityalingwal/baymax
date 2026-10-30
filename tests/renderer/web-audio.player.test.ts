import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebAudioPlayer } from "../../src/renderer/web-audio";
import { bytesIn, bytesOf, createStubOutput, flush } from "./playback.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const decoded = { decoded: "buffer" };

describe("the default Web Audio player", () => {
  it("creates its output on the first play, decodes the exact bytes, then connects and starts one source", async () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    expect(stub.createOutput).not.toHaveBeenCalled();
    const onEnded = vi.fn();
    const started = player.play(bytesOf([6, 7]), onEnded);
    expect(stub.createOutput).toHaveBeenCalledTimes(1);
    expect(bytesIn(stub.decodes[0].audio)).toEqual([6, 7]);
    stub.decodes[0].resolve(decoded);
    await started;
    const source = stub.sources[0];
    expect(source.buffer).toBe(decoded);
    expect(source.connect).toHaveBeenCalledWith(stub.output.destination);
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(stub.output.resume).not.toHaveBeenCalled();
    source.onended?.(new Event("ended"));
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("resumes a suspended output before it creates the source", async () => {
    const stub = createStubOutput("suspended");
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    stub.decodes[0].resolve(decoded);
    await flush();
    expect(stub.output.resume).toHaveBeenCalledTimes(1);
    expect(stub.output.createBufferSource).not.toHaveBeenCalled();
    stub.resumes[0].resolve();
    await started;
    expect(stub.sources[0].start).toHaveBeenCalledTimes(1);
  });
});

describe("the default Web Audio player stops, fails and disposes", () => {
  it("stop() stops and disconnects the current source", async () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    stub.decodes[0].resolve(decoded);
    await started;
    player.stop();
    expect(stub.sources[0].stop).toHaveBeenCalledTimes(1);
    expect(stub.sources[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("a decode failure rejects the play", async () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    stub.decodes[0].reject(new DOMException("bad audio", "EncodingError"));
    await expect(started).rejects.toThrow("bad audio");
    expect(stub.output.createBufferSource).not.toHaveBeenCalled();
  });

  it("dispose() closes the output, and a failing close is caught", async () => {
    const stub = createStubOutput("running");
    stub.output.close.mockReturnValueOnce(Promise.reject(new Error("closed")));
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    stub.decodes[0].resolve(decoded);
    await started;
    player.dispose();
    await flush();
    expect(stub.output.close).toHaveBeenCalledTimes(1);
    expect(stub.sources[0].stop).toHaveBeenCalledTimes(1);
  });
});

describe("the default Web Audio player when a source throws", () => {
  it("a start that throws rejects the play, disconnects the source and never stops it later", async () => {
    const stub = createStubOutput("running");
    stub.faults.start = true;
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    stub.decodes[0].resolve(decoded);
    await expect(started).rejects.toThrow("start failed");
    expect(stub.sources[0].disconnect).toHaveBeenCalledTimes(1);
    player.stop();
    expect(stub.sources[0].stop).not.toHaveBeenCalled();
  });

  it("a stop that throws still disconnects, and dispose still closes the output", async () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    stub.decodes[0].resolve(decoded);
    await started;
    stub.faults.stop = true;
    expect(() => player.dispose()).toThrow("stop failed");
    expect(stub.sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(stub.output.close).toHaveBeenCalledTimes(1);
  });
});

describe("a stopped or replaced play never starts audio", () => {
  it("a stop while decoding: no source is created", async () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    player.stop();
    stub.decodes[0].resolve(decoded);
    await started;
    expect(stub.output.createBufferSource).not.toHaveBeenCalled();
  });

  it("a stop while resuming: no source is created", async () => {
    const stub = createStubOutput("suspended");
    const player = createWebAudioPlayer(stub.createOutput);
    const started = player.play(bytesOf([1]), vi.fn());
    stub.decodes[0].resolve(decoded);
    await flush();
    player.stop();
    stub.resumes[0].resolve();
    await started;
    expect(stub.output.createBufferSource).not.toHaveBeenCalled();
  });

  it("a new play while decoding: only the new play's source is created and started", async () => {
    const stub = createStubOutput("running");
    const player = createWebAudioPlayer(stub.createOutput);
    const first = player.play(bytesOf([1]), vi.fn());
    const second = player.play(bytesOf([2]), vi.fn());
    stub.decodes[0].resolve({ decoded: "first" });
    await first;
    expect(stub.output.createBufferSource).not.toHaveBeenCalled();
    stub.decodes[1].resolve(decoded);
    await second;
    expect(stub.sources).toHaveLength(1);
    expect(stub.sources[0].buffer).toBe(decoded);
    expect(stub.sources[0].start).toHaveBeenCalledTimes(1);
    expect(stub.createOutput).toHaveBeenCalledTimes(1);
  });
});
