import { speechStartBufferMs } from "../shared/ipc";
import { fromPcm16 } from "./pcm";

// Our own small adapter over Web Audio, so tests need no DOM.
export type Player = {
  play(audio: ArrayBuffer, onEnded: () => void): Promise<void>; // resolves once started; rejects when the audio cannot be decoded or started
  queue(pcm: ArrayBuffer, sampleRate: number): void; // a streamed chunk; the first starts a line after the start buffer, the rest follow it back to back
  whenDrained(onDrained: () => void): void; // once every queued chunk has played; at once when none is left
  stop(): void; // stops the current source and every queued chunk, or cancels a play still decoding
  dispose(): void;
};

type AudioSource = {
  buffer: object | null;
  onended: ((event: Event) => void) | null;
  connect(destination: object): void;
  disconnect(): void;
  start(when?: number): void;
  stop(): void;
};

type PcmBuffer = { getChannelData(channel: number): Float32Array };

// The slice of AudioContext the default player uses, so tests can stub it.
export type AudioOutput = {
  readonly state: string;
  readonly destination: object;
  readonly currentTime: number;
  decodeAudioData(audio: ArrayBuffer): Promise<object>;
  createBuffer(channels: number, length: number, sampleRate: number): PcmBuffer;
  createBufferSource(): AudioSource;
  resume(): Promise<void>;
  close(): Promise<void>;
};

type WebAudio = {
  createOutput: () => AudioOutput;
  output: AudioOutput | null;
  source: AudioSource | null;
  queued: Set<AudioSource>;
  nextStart: number; // where the next queued chunk starts on the output's timeline
  leadLeft: number | null; // seconds of lead silence the open line may still drop; null when no line is open
  onDrained: (() => void) | null;
  // Bumped by every play and stop, so a play that was stopped or replaced never starts audio.
  generation: number;
};

// Aura opens most lines with 110-320 ms of silence, so dropping it gives the start buffer's time back.
const leadTrimLimitMs = 300;
// Under this a sample counts as lead silence; not measured on Aura's audio.
const leadSilencePeak = 0.01;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

function stopSource(web: WebAudio): void {
  web.generation += 1;
  web.onDrained = null;
  web.nextStart = 0;
  web.leadLeft = null;
  const sources = [...web.queued, ...(web.source === null ? [] : [web.source])];
  web.source = null;
  web.queued.clear();
  // Every source is stopped and disconnected even when one throws; the first throw is passed on.
  const failures: unknown[] = [];
  for (const source of sources) {
    try {
      source.stop();
    } catch (error) {
      failures.push(error);
    } finally {
      source.disconnect();
    }
  }
  if (failures.length > 0) throw failures[0];
}

function outputOf(web: WebAudio): AudioOutput {
  web.output ??= web.createOutput();
  return web.output;
}

async function playAudio(
  web: WebAudio,
  audio: ArrayBuffer,
  onEnded: () => void,
): Promise<void> {
  stopSource(web);
  const generation = web.generation;
  const output = outputOf(web);
  const decoded = await output.decodeAudioData(audio);
  if (generation !== web.generation) return;
  if (output.state === "suspended") {
    await output.resume();
    if (generation !== web.generation) return;
  }
  const source = output.createBufferSource();
  source.buffer = decoded;
  source.connect(output.destination);
  source.onended = () => onEnded();
  try {
    source.start();
  } catch (error) {
    source.disconnect();
    throw error;
  }
  // Kept only once started, so a later stop never meets a source that never ran.
  web.source = source;
}

function drained(web: WebAudio): void {
  const onDrained = web.onDrained;
  if (web.queued.size > 0 || onDrained === null) return;
  web.onDrained = null;
  web.leadLeft = null;
  onDrained();
}

// The start buffer counts from the first chunk, even when that chunk is all lead silence.
function openLine(web: WebAudio, output: AudioOutput): number {
  if (web.leadLeft !== null) return web.leadLeft;
  web.nextStart = output.currentTime + speechStartBufferMs / 1000;
  return leadTrimLimitMs / 1000;
}

function dropLeadSilence(
  web: WebAudio,
  output: AudioOutput,
  chunk: { samples: Float32Array; sampleRate: number },
): Float32Array {
  const { samples, sampleRate } = chunk;
  const leadLeft = openLine(web, output);
  const limit = Math.min(samples.length, Math.round(leadLeft * sampleRate));
  let first = 0;
  while (first < limit && Math.abs(samples[first]) < leadSilencePeak) {
    first += 1;
  }
  web.leadLeft = first < limit ? 0 : leadLeft - first / sampleRate;
  return samples.subarray(first);
}

// Chunks are scheduled back to back on the output's one timeline, so they play without gaps.
function queueChunk(web: WebAudio, pcm: ArrayBuffer, sampleRate: number) {
  const output = outputOf(web);
  if (output.state === "suspended") {
    output.resume().catch((error: unknown) => {
      console.log(`[Playback] resuming the output failed: ${errorName(error)}`);
    });
  }
  const chunk = { samples: fromPcm16(pcm), sampleRate };
  const samples = dropLeadSilence(web, output, chunk);
  if (samples.length === 0) return;
  const buffer = output.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = output.createBufferSource();
  source.buffer = buffer;
  source.connect(output.destination);
  source.onended = () => {
    if (!web.queued.delete(source)) return;
    source.disconnect();
    drained(web);
  };
  const startAt = Math.max(output.currentTime, web.nextStart);
  try {
    source.start(startAt);
  } catch (error) {
    source.disconnect();
    console.log(`[Playback] a chunk did not start: ${errorName(error)}`);
    return;
  }
  web.nextStart = startAt + samples.length / sampleRate;
  web.queued.add(source);
}

function disposeOutput(web: WebAudio): void {
  const output = web.output;
  web.output = null;
  try {
    stopSource(web);
  } finally {
    output?.close().catch((error: unknown) => {
      console.log(`[Playback] closing the output failed: ${errorName(error)}`);
    });
  }
}

export function createWebAudioPlayer(createOutput: () => AudioOutput): Player {
  const web: WebAudio = {
    createOutput,
    output: null,
    source: null,
    queued: new Set(),
    nextStart: 0,
    leadLeft: null,
    onDrained: null,
    generation: 0,
  };
  return {
    play: (audio, onEnded) => playAudio(web, audio, onEnded),
    queue: (pcm, sampleRate) => queueChunk(web, pcm, sampleRate),
    whenDrained: (onDrained) => {
      web.onDrained = onDrained;
      drained(web);
    },
    stop: () => stopSource(web),
    dispose: () => disposeOutput(web),
  };
}
