import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebAudioCapture } from "../../src/renderer/capture";

type Port = {
  onmessage: ((event: MessageEvent) => void) | null;
  posted: unknown[];
  postMessage: (message: unknown) => void;
};

type Processor = { process: (inputs: Float32Array[][]) => boolean };

// Built from entries, since lint's id-denylist rejects a `data` key.
const flushEvent = () =>
  new MessageEvent("message", Object.fromEntries([["data", "flush"]]));

afterEach(() => {
  vi.unstubAllGlobals();
});

const graphNode = () => ({
  connect: () => undefined,
  disconnect: () => undefined,
});

// Starts a capture on a faked audio graph and returns the module URL it loaded into the worklet.
async function loadedWorkletUrl(): Promise<string> {
  const modules: string[] = [];
  vi.stubGlobal("AudioContext", function FakeContext() {
    return {
      state: "running",
      destination: {},
      audioWorklet: {
        addModule: async (url: string) => void modules.push(url),
      },
      createMediaStreamSource: graphNode,
      close: async () => undefined,
    };
  });
  vi.stubGlobal("AudioWorkletNode", function FakeNode() {
    return {
      ...graphNode(),
      port: { onmessage: null, postMessage: () => undefined },
    };
  });
  await startWebAudioCapture({ getTracks: () => [] }, () => undefined);
  return modules[0];
}

// Runs the worklet's source the way the AudioWorklet scope would, with its globals faked.
async function loadProcessor(sampleRate: number) {
  const prefix = "data:text/javascript;base64,";
  const url = await loadedWorkletUrl();
  expect(url.startsWith(prefix)).toBe(true);
  const port: Port = {
    onmessage: null,
    posted: [],
    postMessage: () => undefined,
  };
  port.postMessage = (message) => port.posted.push(message);
  function FakeProcessor(this: { port: Port }) {
    this.port = port;
  }
  const registered: { name: string; processor: unknown }[] = [];
  const register = (name: string, processor: unknown) =>
    registered.push({ name, processor });
  const run = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    atob(url.slice(prefix.length)),
  );
  run(FakeProcessor, register, sampleRate);
  expect(registered.map((entry) => entry.name)).toEqual(["baymax-pcm"]);
  const Registered = registered[0].processor as new () => Processor;
  return { processor: new Registered(), port };
}

describe("the PCM worklet", () => {
  it("posts 40 ms frames of 16 kHz PCM, then the rest and a flushed reply on a flush", async () => {
    const { processor, port } = await loadProcessor(48_000);
    for (let block = 0; block < 20; block += 1) {
      expect(processor.process([[new Float32Array(128).fill(0.5)]])).toBe(true);
    }
    port.onmessage?.(flushEvent());
    const sizes = port.posted.map((message) =>
      message instanceof ArrayBuffer ? message.byteLength : message,
    );
    expect(sizes).toEqual([1280, 428, "flushed"]);
    const first = port.posted[0];
    if (!(first instanceof ArrayBuffer)) throw new Error("expected a frame");
    expect(new DataView(first).getInt16(0, true)).toBe(16383);
  });

  it("keeps running with no input and posts nothing", async () => {
    const { processor, port } = await loadProcessor(48_000);
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);
    port.onmessage?.(flushEvent());
    expect(port.posted).toEqual(["flushed"]);
  });
});
