import type {
  BaymaxApi,
  LineId,
  PlaybackFinished,
  SpeechLine,
} from "../shared/ipc";

// Our own small adapter over Web Audio, so tests need no DOM.
export type Player = {
  play(audio: ArrayBuffer, onEnded: () => void): Promise<void>; // resolves once started; rejects when the audio cannot be decoded or started
  stop(): void; // stops the current source or cancels a play still decoding
  dispose(): void;
};

type AudioSource = {
  buffer: object | null;
  onended: ((event: Event) => void) | null;
  connect(destination: object): void;
  disconnect(): void;
  start(): void;
  stop(): void;
};

// The slice of AudioContext the default player uses, so tests can stub it.
export type AudioOutput = {
  readonly state: string;
  readonly destination: object;
  decodeAudioData(audio: ArrayBuffer): Promise<object>;
  createBufferSource(): AudioSource;
  resume(): Promise<void>;
  close(): Promise<void>;
};

type WebAudio = {
  createOutput: () => AudioOutput;
  output: AudioOutput | null;
  source: AudioSource | null;
  // Bumped by every play and stop, so a play that was stopped or replaced never starts audio.
  generation: number;
};

type Bridge = Pick<
  BaymaxApi,
  "onSpeech" | "onStopPlayback" | "reportPlaybackFinished"
>;

type Playback = {
  bridge: Bridge;
  player: Player;
  active: LineId | null;
  disposed: boolean;
};

function stopSource(web: WebAudio): void {
  web.generation += 1;
  const source = web.source;
  web.source = null;
  if (source === null) return;
  try {
    source.stop();
  } finally {
    source.disconnect();
  }
}

async function playAudio(
  web: WebAudio,
  audio: ArrayBuffer,
  onEnded: () => void,
): Promise<void> {
  stopSource(web);
  const generation = web.generation;
  web.output ??= web.createOutput();
  const output = web.output;
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
    generation: 0,
  };
  return {
    play: (audio, onEnded) => playAudio(web, audio, onEnded),
    stop: () => stopSource(web),
    dispose: () => disposeOutput(web),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

// A throwing player or bridge must not leave a line half-finished.
function logged(what: string, call: () => void): void {
  try {
    call();
  } catch (error) {
    console.log(`[Playback] ${what} failed: ${errorName(error)}`);
  }
}

function isActive(playback: Playback, lineId: LineId): boolean {
  return !playback.disposed && playback.active === lineId;
}

// The one way a line ends, so each line is reported exactly once.
function finish(
  playback: Playback,
  lineId: LineId,
  outcome: PlaybackFinished["outcome"],
): void {
  if (!isActive(playback, lineId)) return;
  playback.active = null;
  if (outcome === "stopped") logged("stopping", () => playback.player.stop());
  logged("reporting", () =>
    playback.bridge.reportPlaybackFinished({ lineId, outcome }),
  );
}

function playFailed(playback: Playback, lineId: LineId, error: unknown) {
  if (!isActive(playback, lineId)) return;
  console.log(`[Playback] failed: ${errorName(error)}`);
  finish(playback, lineId, "failed");
}

function playLine(playback: Playback, line: SpeechLine): void {
  if (playback.disposed) return;
  if (playback.active !== null) finish(playback, playback.active, "stopped");
  const { lineId } = line;
  playback.active = lineId;
  const ended = () => finish(playback, lineId, "ended");
  // Wrapped so a synchronous throw takes the same path as a rejection.
  new Promise<void>((resolve) =>
    resolve(playback.player.play(line.audio, ended)),
  ).catch((error: unknown) => playFailed(playback, lineId, error));
}

function closePlayback(playback: Playback): void {
  playback.disposed = true;
  playback.active = null;
  logged("stopping", () => playback.player.stop());
  logged("disposing", () => playback.player.dispose());
}

export function startPlayback(
  bridge: Bridge,
  player: Player = createWebAudioPlayer(() => new AudioContext()),
): () => void {
  const playback: Playback = { bridge, player, active: null, disposed: false };
  const unsubscribeSpeech = bridge.onSpeech((line) => playLine(playback, line));
  const unsubscribeStop = bridge.onStopPlayback(({ lineId }) =>
    finish(playback, lineId, "stopped"),
  );
  return () => {
    if (playback.disposed) return;
    unsubscribeSpeech();
    unsubscribeStop();
    // The page is going away, so nothing is reported.
    closePlayback(playback);
  };
}
