import type {
  TextOutcome,
  TextRequest,
  TextStream,
} from "../providers/anthropic";
import type { Synthesis, Transcription } from "../providers/deepgram";
import type { DisplayState, TaskId } from "../shared/cards";
import type { EngineCommand, EngineEvent, EnginePort } from "../shared/engine";
import { ipcChannels } from "../shared/ipc";
import type { RecordingCommand, SpeechLine, StopPlayback } from "../shared/ipc";
import type { RendererListener, RendererSender } from "./renderer-actions";
import { createClock, findings, intake, newTask } from "./tasks/harness";
import { wireMain } from "./wiring";

type Options = {
  sendFails?: (command: EngineCommand) => boolean;
  idFails?: boolean;
  deepgramKeyPresent?: boolean;
  voiceFails?: boolean; // transcription and synthesis answer a Deepgram failure
  port?: EnginePort; // a real engine; the fake port records around it
  talker?: boolean; // a fake talker model the test answers; without it there is no Anthropic key
};

type TalkerCall = {
  request: TextRequest;
  onText: (text: string) => void;
  resolve: (outcome: TextOutcome) => void;
};

// The talker's model call faked: each call waits until a test streams its text and settles it.
function fakeTalker() {
  const calls: TalkerCall[] = [];
  const stream: TextStream = (request, _options, onText) =>
    new Promise<TextOutcome>((resolve) =>
      calls.push({ request, onText, resolve }),
    );
  return { calls, stream };
}

type Pending<T> = { input: string; resolve: (result: T) => void };

const deepgramDown = {
  kind: "failed",
  cause: "unreachable",
  detail: "x",
} as const;

// Deepgram and the renderer sends faked, with no Flux socket so held audio goes to the batch call; each call waits until a test settles it, or fails at once when voice fails.
function fakeVoice(deepgramKeyPresent: boolean, fails: boolean) {
  const seen = {
    recordings: [] as RecordingCommand[],
    speeches: [] as SpeechLine[],
    stops: [] as StopPlayback[],
    transcriptions: [] as Pending<Transcription>[],
    syntheses: [] as Pending<Synthesis>[],
    voiceLogs: [] as string[],
  };
  const deps = {
    sendRecording: (command: RecordingCommand) => seen.recordings.push(command),
    sendSpeech: (line: SpeechLine) => seen.speeches.push(line),
    sendChunk: () => undefined,
    sendEnd: () => undefined,
    startAura: () => null,
    sendStop: (payload: StopPlayback) => seen.stops.push(payload),
    // The input is the mime type and the PCM after the 44-byte WAV header.
    transcribe: (audio: ArrayBuffer, mimeType: string) =>
      new Promise<Transcription>((resolve) => {
        const bytes = [...new Uint8Array(audio, 44)].join(",");
        seen.transcriptions.push({ input: `${mimeType} ${bytes}`, resolve });
        if (fails) resolve(deepgramDown);
      }),
    startFlux: () => null,
    synthesize: (text: string) =>
      new Promise<Synthesis>((resolve) => {
        seen.syntheses.push({ input: text, resolve });
        if (fails) resolve(deepgramDown);
      }),
    now: () => 0,
    log: (message: string) => seen.voiceLogs.push(message),
    deepgramKeyPresent,
  };
  return { seen, deps };
}

// Records every command and event; with a real engine it forwards commands to it and passes on its events.
function fakePort(
  sendFails: (command: EngineCommand) => boolean,
  real: EnginePort | null,
) {
  const sent: EngineCommand[] = [];
  const events: EngineEvent[] = [];
  let listeners: ((event: EngineEvent) => void)[] = [];
  let closes = 0;
  const emit = (event: EngineEvent) => {
    events.push(event);
    [...listeners].forEach((l) => l(event));
  };
  real?.onMessage(emit);
  const port: EnginePort = {
    send: (command) => {
      if (sendFails(command)) throw new Error(`send ${command.type} broke`);
      sent.push(command);
      real?.send(command);
    },
    onMessage: (listener) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((other) => other !== listener);
      };
    },
    // Counts only, so a test can tell the wiring's own unsubscribe from the port's.
    close: () => {
      closes += 1;
      real?.close();
    },
  };
  return {
    port,
    sent,
    events,
    emit,
    listeners: () => listeners.length,
    closes: () => closes,
  };
}

function fakeIpc() {
  const listeners = new Map<string, RendererListener[]>();
  let removals = 0;
  const ipc = {
    on: (channel: string, listener: RendererListener) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
    removeListener: (channel: string, listener: RendererListener) => {
      removals += 1;
      const rest = (listeners.get(channel) ?? []).filter((l) => l !== listener);
      listeners.set(channel, rest);
    },
  };
  const call = (channel: string, payload: unknown, sender: RendererSender) =>
    (listeners.get(channel) ?? []).forEach((l) => l({ sender }, payload));
  const count = () =>
    [...listeners.values()].reduce((total, list) => total + list.length, 0);
  return { ipc, call, count, removals: () => removals };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The fake audio of a line is its own text, so a test reads what was sent as speech.
const audioOf = (text: string): Synthesis => ({
  kind: "audio",
  audio: new TextEncoder().encode(text).buffer,
  mimeType: "audio/mpeg",
});

function playback(
  seen: ReturnType<typeof fakeVoice>["seen"],
  send: (channel: string, payload?: unknown) => void,
) {
  let settled = 0;
  const settleNext = async (): Promise<SpeechLine | undefined> => {
    const job = seen.syntheses.at(settled);
    if (job === undefined) throw new Error("no synthesis to settle");
    settled += 1;
    const before = seen.speeches.length;
    job.resolve(audioOf(job.input));
    await flush();
    return seen.speeches.at(before);
  };
  const playNext = async (): Promise<void> => {
    const line = await settleNext();
    if (line === undefined) return;
    send(ipcChannels.playbackFinished, {
      lineId: line.lineId,
      outcome: "ended",
    });
  };
  const playAll = async (): Promise<void> => {
    for (let turn = 0; turn < 20 && settled < seen.syntheses.length; turn += 1)
      await playNext();
  };
  const spoken = () =>
    seen.speeches.map((line) => new TextDecoder().decode(line.audio));
  return { settleNext, playNext, playAll, spoken };
}

export function fakeSender() {
  const received: [string, DisplayState][] = [];
  const sender: RendererSender = {
    send: (channel, display) => received.push([channel, display]),
  };
  return { sender, received };
}

function fakesFor(options: Options) {
  return {
    clock: createClock(),
    talker: fakeTalker(),
    port: fakePort(options.sendFails ?? (() => false), options.port ?? null),
    ipc: fakeIpc(),
    own: fakeSender(),
    voice: fakeVoice(
      options.deepgramKeyPresent ?? true,
      options.voiceFails ?? false,
    ),
  };
}

export function wire(options: Options = {}) {
  const { clock, port, ipc, own, voice, talker } = fakesFor(options);
  const seen = {
    published: [] as DisplayState[],
    opened: [] as string[],
    logs: [] as string[],
    failures: [] as unknown[],
  };
  let ids = 0;
  const wiring = wireMain({
    port: port.port,
    talkerStream: options.talker === true ? talker.stream : null,
    ipc: ipc.ipc,
    isOwnSender: (sender) => sender === own.sender,
    publish: (display) => seen.published.push(display),
    openUrl: (url) => {
      seen.opened.push(url);
      return Promise.resolve();
    },
    log: (message) => seen.logs.push(message),
    timers: { setTimer: clock.setTimer },
    newTaskId: () => {
      if (options.idFails) throw new Error("no task id");
      ids += 1;
      return `t${ids}`;
    },
    fail: (error) => seen.failures.push(error),
    voice: voice.deps,
  });
  const send = (channel: string, payload?: unknown, sender = own.sender) =>
    ipc.call(channel, payload, sender);
  const card = (taskId: TaskId) =>
    seen.published.at(-1)?.tasks.find((shown) => shown.taskId === taskId);
  const speech = playback(voice.seen, send);
  return {
    ...seen,
    ...voice.seen,
    ...speech,
    advance: clock.advance,
    talkerCalls: talker.calls,
    wiring,
    port,
    ipc,
    own,
    send,
    card,
  };
}

export type Wired = ReturnType<typeof wire>;

export const source = "https://example.com/hermes";

export function submit(w: Wired): void {
  w.send(ipcChannels.submitQuestion, { text: "  how does Hermes work?  " });
}

export function admitTask(w: Wired): void {
  submit(w);
  w.port.emit(intake("t1", newTask("how Hermes works")));
}

export function runToDone(w: Wired): void {
  admitTask(w);
  w.port.emit({
    type: "result",
    taskId: "t1",
    spokenLine: "Hermes runs a loop.",
    findings: findings("Hermes runs a loop.", [source]),
  });
}

// Asks by the text box and admits the new card as a new task; taskId is the id the ask mints.
export function admitAs(w: Wired, taskId: TaskId, sayBack: string): void {
  w.send(ipcChannels.submitQuestion, { text: `tell me ${sayBack}` });
  w.port.emit(intake(taskId, newTask(sayBack)));
}
