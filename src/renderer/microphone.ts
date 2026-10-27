import type { BaymaxApi, Clip, RecordingCommand } from "../shared/ipc";

export type MicStream = { getTracks(): { stop(): void }[] };
// Our own small adapter, not a mirror of MediaRecorder (lint's id-denylist rejects a `data` key).
export type Recorder = {
  readonly mimeType: string;
  start(): void;
  stop(): void;
  onChunk(listener: (chunk: Blob) => void): void;
  onStart(listener: () => void): void;
  onStop(listener: () => void): void;
  onError(listener: () => void): void;
};
export type MicDeps = {
  getUserMedia: () => Promise<MicStream>;
  createRecorder: (stream: MicStream) => Recorder;
  now: () => number;
};

type Bridge = Pick<BaymaxApi, "onRecording" | "sendClip">;
type UtteranceId = RecordingCommand["utteranceId"];
type FailReason = Extract<Clip, { outcome: "failed" }>["reason"];

type Utterance = {
  utteranceId: UtteranceId;
  startedAt: number;
  stopped: boolean;
  sent: boolean;
  stream?: MicStream;
  recorder?: Recorder;
  chunks: Blob[];
  failure?: FailReason;
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

function createMediaRecorder(stream: MicStream): Recorder {
  const recorder = new MediaRecorder(stream as MediaStream, {
    mimeType: "audio/webm;codecs=opus",
  });
  return {
    get mimeType() {
      return recorder.mimeType;
    },
    start: () => recorder.start(),
    stop: () => recorder.stop(),
    onChunk: (listener) =>
      recorder.addEventListener("dataavailable", (event) =>
        listener(event.data),
      ),
    onStart: (listener) => recorder.addEventListener("start", () => listener()),
    onStop: (listener) => recorder.addEventListener("stop", () => listener()),
    onError: (listener) => recorder.addEventListener("error", () => listener()),
  };
}

const browserDeps: MicDeps = {
  getUserMedia: () => navigator.mediaDevices.getUserMedia(micConstraints),
  createRecorder: createMediaRecorder,
  // An arrow, since a detached performance.now throws "Illegal invocation" in Chromium.
  now: () => performance.now(),
};

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return typeof error.name === "string" ? error.name : String(error);
  }
  return String(error);
}

function reasonFor(name: string): FailReason {
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

function stopTracks(stream: MicStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function sendOnce(mic: Mic, utterance: Utterance, clip: Clip): void {
  if (utterance.sent || mic.disposed) return;
  utterance.sent = true;
  mic.live.delete(utterance);
  mic.bridge.sendClip(clip);
}

function sendFailure(mic: Mic, utterance: Utterance): void {
  const reason = utterance.failure ?? "error";
  const { utteranceId } = utterance;
  sendOnce(mic, utterance, { utteranceId, outcome: "failed", reason });
}

function fail(
  mic: Mic,
  utterance: Utterance,
  reason: FailReason,
  name: string,
) {
  console.log(`[Mic] failed: ${name}`);
  utterance.failure ??= reason;
  stopTracks(utterance.stream);
  if (utterance.stopped) sendFailure(mic, utterance);
}

function sendRecorded(mic: Mic, utterance: Utterance, audio: ArrayBuffer) {
  const { utteranceId } = utterance;
  const mimeType = utterance.recorder?.mimeType ?? "";
  console.log(`[Mic] clip ${audio.byteLength} bytes`);
  sendOnce(mic, utterance, {
    utteranceId,
    outcome: "recorded",
    audio,
    mimeType,
  });
}

function recorderStopped(mic: Mic, utterance: Utterance): void {
  if (utterance.sent || mic.disposed) return;
  // A recorder that stops on its own (a lost device) must not send before main's stop.
  if (!utterance.stopped)
    return fail(mic, utterance, "error", "RecorderStopped");
  stopTracks(utterance.stream);
  if (utterance.failure !== undefined) return sendFailure(mic, utterance);
  const blob = new Blob(utterance.chunks, {
    type: utterance.recorder?.mimeType,
  });
  blob
    .arrayBuffer()
    .then((audio) => sendRecorded(mic, utterance, audio))
    .catch((error: unknown) => fail(mic, utterance, "error", errorName(error)));
}

function startRecorder(mic: Mic, utterance: Utterance, stream: MicStream) {
  try {
    const recorder = mic.deps.createRecorder(stream);
    utterance.recorder = recorder;
    recorder.onChunk((chunk) => utterance.chunks.push(chunk));
    recorder.onStart(() =>
      console.log(
        `[Mic] recording ${sinceStart(mic, utterance)} ms after start`,
      ),
    );
    recorder.onStop(() => recorderStopped(mic, utterance));
    recorder.onError(() => fail(mic, utterance, "error", "RecorderError"));
    recorder.start();
  } catch (error) {
    fail(mic, utterance, "error", errorName(error));
  }
}

function streamReady(mic: Mic, utterance: Utterance, stream: MicStream): void {
  utterance.stream = stream;
  if (mic.disposed) return stopTracks(stream);
  console.log(
    `[Mic] stream ready ${sinceStart(mic, utterance)} ms after start`,
  );
  if (!utterance.stopped) return startRecorder(mic, utterance, stream);
  stopTracks(stream);
  const { utteranceId } = utterance;
  const audio = new ArrayBuffer(0);
  console.log("[Mic] clip 0 bytes");
  sendOnce(mic, utterance, {
    utteranceId,
    outcome: "recorded",
    audio,
    mimeType: "",
  });
}

function beginUtterance(mic: Mic, utteranceId: UtteranceId): void {
  const utterance: Utterance = {
    utteranceId,
    startedAt: mic.deps.now(),
    stopped: false,
    sent: false,
    chunks: [],
  };
  mic.current = utterance;
  mic.live.add(utterance);
  mic.deps
    .getUserMedia()
    .then((stream) => streamReady(mic, utterance, stream))
    .catch((error: unknown) => {
      const name = errorName(error);
      fail(mic, utterance, reasonFor(name), name);
    });
}

function stopUtterance(mic: Mic, utterance: Utterance): void {
  utterance.stopped = true;
  if (mic.current === utterance) mic.current = null;
  if (utterance.failure !== undefined) return sendFailure(mic, utterance);
  if (utterance.recorder === undefined) return;
  try {
    utterance.recorder.stop();
  } catch (error) {
    fail(mic, utterance, "error", errorName(error));
  }
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
    stopTracks(utterance.stream);
    if (utterance.recorder !== undefined && !utterance.stopped) {
      utterance.stopped = true;
      try {
        utterance.recorder.stop();
      } catch (error) {
        console.log(`[Mic] failed: ${errorName(error)}`);
      }
    }
  }
  mic.live.clear();
}

export function startMicrophone(
  bridge: Pick<BaymaxApi, "onRecording" | "sendClip">,
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
