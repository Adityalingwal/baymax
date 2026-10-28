import { toPcm16 } from "./pcm";

export type MicStream = { getTracks(): { stop(): void }[] };

// One running capture: flush posts the frames still buffered, close releases the audio graph.
export type Capture = { flush: () => Promise<void>; close: () => void };

export type StartCapture = (
  stream: MicStream,
  onFrame: (pcm: ArrayBuffer) => void,
) => Promise<Capture>;

const processorName = "baymax-pcm";
// A frame of 40 ms at 16 kHz, 16-bit.
const frameBytes = 1280;
// A worklet that never answers a flush must not keep the end of the utterance from main.
const flushTimeoutMs = 300;

// The worklet scope has no imports, so the converter goes in as source; AudioWorkletProcessor requires a class.
const processorSource = `
const toPcm16 = (${toPcm16.toString()});
class BaymaxPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.next = 0;
    this.parts = [];
    this.size = 0;
    this.port.onmessage = (event) => {
      if (event.data !== "flush") return;
      this.post();
      this.port.postMessage("flushed");
    };
  }
  post() {
    if (this.size === 0) return;
    const frame = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      frame.set(part, offset);
      offset += part.length;
    }
    this.parts = [];
    this.size = 0;
    this.port.postMessage(frame.buffer, [frame.buffer]);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      const converted = toPcm16(channel, sampleRate, this.next);
      this.next = converted.next;
      this.parts.push(converted.bytes);
      this.size += converted.bytes.length;
      if (this.size >= ${frameBytes}) this.post();
    }
    return true;
  }
}
registerProcessor("${processorName}", BaymaxPcm);
`;

// Loaded as a data URL, which the page's CSP allows for scripts, so no bundler change is needed.
export function workletUrl(): string {
  return `data:text/javascript;base64,${btoa(processorSource)}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

function listen(
  node: AudioWorkletNode,
  onFrame: (pcm: ArrayBuffer) => void,
): { flushed: () => Promise<void> } {
  let flushed: (() => void) | null = null;
  node.port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (message instanceof ArrayBuffer) onFrame(message);
    else if (message === "flushed") flushed?.();
  };
  return {
    flushed: () =>
      new Promise<void>((resolve) => {
        flushed = resolve;
        setTimeout(resolve, flushTimeoutMs);
        node.port.postMessage("flush");
      }),
  };
}

export const startWebAudioCapture: StartCapture = async (stream, onFrame) => {
  const context = new AudioContext();
  const closeContext = (): void => {
    context.close().catch((error: unknown) => {
      console.log(`[Mic] closing the capture failed: ${errorName(error)}`);
    });
  };
  try {
    await context.audioWorklet.addModule(workletUrl());
    if (context.state === "suspended") await context.resume();
    const source = context.createMediaStreamSource(stream as MediaStream);
    const node = new AudioWorkletNode(context, processorName);
    const port = listen(node, onFrame);
    source.connect(node);
    // Its output is silent; connected so the graph keeps pulling the worklet.
    node.connect(context.destination);
    return {
      flush: port.flushed,
      close: () => {
        source.disconnect();
        node.disconnect();
        node.port.onmessage = null;
        closeContext();
      },
    };
  } catch (error) {
    closeContext();
    throw error;
  }
};
