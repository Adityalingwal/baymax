import type {
  BaymaxApi,
  MicAudio,
  MicFailure,
  RecordingCommand,
} from "../shared/ipc";
import { startWebAudioCapture } from "./capture";
import type { Capture, MicStream, StartCapture } from "./capture";

export type MicDeps = {
  getUserMedia: () => Promise<MicStream>;
  startCapture: StartCapture;
  now: () => number;
};

type Bridge = Pick<BaymaxApi, "onRecording" | "sendMicAudio">;
type UtteranceId = RecordingCommand["utteranceId"];

type Utterance = {
  utteranceId: UtteranceId;
  startedAt: number;
  stopped: boolean;
  finished: boolean; // its end or failure went to main; nothing more is sent
  stream?: MicStream;
  capture?: Capture;
  failure?: MicFailure;
};

type Mic = {
  bridge: Bridge;
  deps: MicDeps;
  current: Utterance | null;
  live: Set<Utterance>;
  disposed: boolean;
};

const micConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

const browserDeps: MicDeps = {
  getUserMedia: () => navigator.mediaDevices.getUserMedia(micConstraints),
  startCapture: startWebAudioCapture,
  // An arrow, since a detached performance.now throws "Illegal invocation" in Chromium.
  now: () => performance.now(),
};

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return typeof error.name === "string" ? error.name : String(error);
  }
  return String(error);
}

function reasonFor(name: string): MicFailure {
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "permissionDenied";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "noMicrophone";
  }
  return "error";
}

function sinceStart(mic: Mic, utterance: Utterance): number {
  return Math.round(mic.deps.now() - utterance.startedAt);
}

// Stops the tracks and the audio graph; a throwing close must not keep the tracks running.
function release(utterance: Utterance): void {
  const capture = utterance.capture;
  utterance.capture = undefined;
  try {
    capture?.close();
  } finally {
    for (const track of utterance.stream?.getTracks() ?? []) track.stop();
  }
}

function send(mic: Mic, audio: MicAudio): void {
  if (!mic.disposed) mic.bridge.sendMicAudio(audio);
}

function finish(mic: Mic, utterance: Utterance): void {
  if (utterance.finished) return;
  utterance.finished = true;
  mic.live.delete(utterance);
  release(utterance);
  const { utteranceId, failure } = utterance;
  if (failure === undefined) send(mic, { type: "end", utteranceId });
  else send(mic, { type: "failed", utteranceId, reason: failure });
}

function fail(
  mic: Mic,
  utterance: Utterance,
  reason: MicFailure,
  name: string,
) {
  console.log(`[Mic] failed: ${name}`);
  utterance.failure ??= reason;
  release(utterance);
  if (utterance.stopped) finish(mic, utterance);
}

// The worklet posts its last frames before it answers the flush, so the end follows every frame.
function endCapture(mic: Mic, utterance: Utterance, capture: Capture): void {
  new Promise<void>((resolve) => resolve(capture.flush()))
    .catch((error: unknown) => {
      console.log(`[Mic] flush failed: ${errorName(error)}`);
    })
    .finally(() => finish(mic, utterance))
    .catch((error: unknown) => {
      console.log(`[Mic] ending failed: ${errorName(error)}`);
    });
}

function captureReady(mic: Mic, utterance: Utterance, capture: Capture) {
  utterance.capture = capture;
  if (mic.disposed || utterance.finished) return release(utterance);
  console.log(`[Mic] capturing ${sinceStart(mic, utterance)} ms after start`);
  if (utterance.stopped) endCapture(mic, utterance, capture);
}

function streamReady(mic: Mic, utterance: Utterance, stream: MicStream): void {
  utterance.stream = stream;
  if (mic.disposed) return release(utterance);
  console.log(
    `[Mic] stream ready ${sinceStart(mic, utterance)} ms after start`,
  );
  if (utterance.stopped) return finish(mic, utterance);
  const { utteranceId } = utterance;
  const onFrame = (pcm: ArrayBuffer) => {
    if (!utterance.finished) send(mic, { type: "frames", utteranceId, pcm });
  };
  // Wrapped so a synchronous throw takes the same path as a rejection.
  new Promise<Capture>((resolve) =>
    resolve(mic.deps.startCapture(stream, onFrame)),
  )
    .then((capture) => captureReady(mic, utterance, capture))
    .catch((error: unknown) => fail(mic, utterance, "error", errorName(error)));
}

function beginUtterance(mic: Mic, utteranceId: UtteranceId): void {
  const utterance: Utterance = {
    utteranceId,
    startedAt: mic.deps.now(),
    stopped: false,
    finished: false,
  };
  mic.current = utterance;
  mic.live.add(utterance);
  new Promise<MicStream>((resolve) => resolve(mic.deps.getUserMedia()))
    .then((stream) => streamReady(mic, utterance, stream))
    .catch((error: unknown) => {
      const name = errorName(error);
      fail(mic, utterance, reasonFor(name), name);
    });
}

function stopUtterance(mic: Mic, utterance: Utterance): void {
  utterance.stopped = true;
  if (mic.current === utterance) mic.current = null;
  const capture = utterance.capture;
  if (utterance.failure !== undefined) finish(mic, utterance);
  else if (capture !== undefined) endCapture(mic, utterance, capture);
}

function receiveCommand(mic: Mic, command: RecordingCommand): void {
  const current = mic.current;
  if (command.type === "start") {
    if (current !== null) stopUtterance(mic, current);
    beginUtterance(mic, command.utteranceId);
  } else if (current?.utteranceId === command.utteranceId) {
    stopUtterance(mic, current);
  }
}

function disposeAll(mic: Mic): void {
  mic.disposed = true;
  mic.current = null;
  for (const utterance of mic.live) {
    utterance.finished = true;
    release(utterance);
  }
  mic.live.clear();
}

// The mic runs only while the key is held: frames go to main as they come, then one end or failure.
export function startMicrophone(
  bridge: Bridge,
  deps: MicDeps = browserDeps,
): () => void {
  const mic: Mic = {
    bridge,
    deps,
    current: null,
    live: new Set(),
    disposed: false,
  };
  const unsubscribe = bridge.onRecording((command) =>
    receiveCommand(mic, command),
  );
  return () => {
    unsubscribe();
    disposeAll(mic);
  };
}
