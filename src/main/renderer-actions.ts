import type { ClarifyingReply, DisplayState } from "../shared/cards";
import { ipcChannels } from "../shared/ipc";
import type { MicAudio, RendererToMain } from "../shared/ipc";
import type { MainState } from "./tasks/state";
import type { Voice } from "./voice";

// Structural, so the actions run in tests without Electron; ipcMain and webContents satisfy them.
export type RendererSender = {
  send: (channel: string, display: DisplayState) => void;
};
export type RendererEvent = { sender: RendererSender };
export type RendererListener = (event: RendererEvent, payload: unknown) => void;
export type RendererIpc = {
  on: (channel: string, listener: RendererListener) => unknown;
  removeListener: (channel: string, listener: RendererListener) => unknown;
};

// What the actions call: main's state, and voice for the mic audio, playback and mute.
export type ActionTargets = {
  state: MainState;
  voice: Pick<Voice, "micAudio" | "playbackFinished" | "setMuted">;
};

export type ActionDeps = {
  isOwnSender: (sender: RendererSender) => boolean;
  fail: (error: unknown) => void;
  log: (message: string) => void;
};

// A throw from the state is a bug, so it goes to the restart path instead of being swallowed.
export function forwardFailure(
  fail: (error: unknown) => void,
  call: () => void,
): void {
  try {
    call();
  } catch (error: unknown) {
    fail(error);
  }
}

type Fields = Partial<Record<string, unknown>>;

function fieldsOf(payload: unknown): Fields | null {
  return typeof payload === "object" && payload !== null
    ? { ...payload }
    : null;
}

function readReply(value: unknown): ClarifyingReply | null {
  const reply = fieldsOf(value);
  if (
    reply?.kind === "choice" &&
    typeof reply.index === "number" &&
    Number.isInteger(reply.index)
  ) {
    return { kind: "choice", index: reply.index };
  }
  if (reply?.kind === "text" && typeof reply.text === "string") {
    return { kind: "text", text: reply.text };
  }
  return null;
}

type Channel = keyof RendererToMain;
type Reader<C extends Channel> = (fields: Fields) => RendererToMain[C] | null;

const readSubmit: Reader<typeof ipcChannels.submitQuestion> = (f) =>
  typeof f.text === "string" ? { text: f.text } : null;

const readTaskAction: Reader<typeof ipcChannels.cancelTask> = (f) =>
  typeof f.taskId === "string" ? { taskId: f.taskId } : null;

const readAnswer: Reader<typeof ipcChannels.answerQuestion> = (f) => {
  const reply = readReply(f.reply);
  return typeof f.taskId === "string" &&
    typeof f.questionId === "string" &&
    reply !== null
    ? { taskId: f.taskId, questionId: f.questionId, reply }
    : null;
};

const readFold: Reader<typeof ipcChannels.setCardFolded> = (f) =>
  typeof f.taskId === "string" && typeof f.folded === "boolean"
    ? { taskId: f.taskId, folded: f.folded }
    : null;

const readOpenSource: Reader<typeof ipcChannels.openSource> = (f) =>
  typeof f.taskId === "string" && typeof f.url === "string"
    ? { taskId: f.taskId, url: f.url }
    : null;

const readMuted: Reader<typeof ipcChannels.setMuted> = (f) =>
  typeof f.muted === "boolean" ? { muted: f.muted } : null;

// Electron's clone of binary data may arrive as a view such as a Buffer, so a view is copied into its own ArrayBuffer.
function readAudio(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (!ArrayBuffer.isView(value)) return null;
  const copy = new Uint8Array(value.byteLength);
  copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return copy.buffer;
}

const micFailures = ["permissionDenied", "noMicrophone", "error"] as const;

const readMicAudio: Reader<typeof ipcChannels.micAudio> = (
  f,
): MicAudio | null => {
  const utteranceId = f.utteranceId;
  if (typeof utteranceId !== "string") return null;
  if (f.type === "frames") {
    const pcm = readAudio(f.pcm);
    return pcm === null ? null : { type: "frames", utteranceId, pcm };
  }
  if (f.type === "end") return { type: "end", utteranceId };
  const reason = micFailures.find((known) => known === f.reason);
  return f.type === "failed" && reason !== undefined
    ? { type: "failed", utteranceId, reason }
    : null;
};

const playbackOutcomes = ["ended", "stopped", "failed"] as const;

const readPlayback: Reader<typeof ipcChannels.playbackFinished> = (f) => {
  const outcome = playbackOutcomes.find((known) => known === f.outcome);
  return typeof f.lineId === "string" && outcome !== undefined
    ? { lineId: f.lineId, outcome }
    : null;
};

type Listen = (targets: ActionTargets, deps: ActionDeps) => RendererListener;
type Action = { channel: string; listen: Listen };

// A message from another sender or with a malformed payload is dropped, never thrown into main.
function action<C extends Channel>(
  channel: C,
  read: Reader<C>,
  run: (targets: ActionTargets, payload: RendererToMain[C]) => void,
): Action {
  const listen: Listen = (targets, deps) => (event, payload) => {
    if (!deps.isOwnSender(event.sender)) {
      deps.log(`${channel} dropped: not from the Baymax window`);
      return;
    }
    const fields = fieldsOf(payload);
    const value = fields === null ? null : read(fields);
    if (value === null) {
      deps.log(`${channel} dropped: malformed payload`);
      return;
    }
    forwardFailure(deps.fail, () => run(targets, value));
  };
  return { channel, listen };
}

const replayDisplay: Action = {
  channel: ipcChannels.getDisplayState,
  listen:
    ({ state }, deps) =>
    (event) => {
      if (!deps.isOwnSender(event.sender)) {
        deps.log(
          `${ipcChannels.getDisplayState} dropped: not from the Baymax window`,
        );
        return;
      }
      forwardFailure(deps.fail, () =>
        event.sender.send(ipcChannels.displayState, state.displayState()),
      );
    },
};

const actions: Action[] = [
  replayDisplay,
  action(ipcChannels.submitQuestion, readSubmit, ({ state }, { text }) =>
    state.ask(text, null, state.waitingQuestion()),
  ),
  action(ipcChannels.answerQuestion, readAnswer, ({ state }, payload) =>
    state.answerQuestion(payload),
  ),
  action(ipcChannels.cancelTask, readTaskAction, ({ state }, { taskId }) =>
    state.cancelTask(taskId),
  ),
  action(ipcChannels.retryTask, readTaskAction, ({ state }, { taskId }) =>
    state.retryTask(taskId),
  ),
  action(ipcChannels.closeCard, readTaskAction, ({ state }, { taskId }) =>
    state.closeCard(taskId),
  ),
  action(ipcChannels.setCardFolded, readFold, ({ state }, payload) =>
    state.setCardFolded(payload),
  ),
  action(ipcChannels.openSource, readOpenSource, ({ state }, payload) =>
    state.openSource(payload),
  ),
  action(ipcChannels.setMuted, readMuted, ({ voice }, { muted }) =>
    voice.setMuted(muted),
  ),
  action(ipcChannels.micAudio, readMicAudio, ({ voice }, audio) =>
    voice.micAudio(audio),
  ),
  action(ipcChannels.playbackFinished, readPlayback, ({ voice }, payload) =>
    voice.playbackFinished(payload),
  ),
];

// Returns a function that removes every listener it registered.
export function registerRendererActions(
  ipc: RendererIpc,
  targets: ActionTargets,
  deps: ActionDeps,
): () => void {
  const registered = actions.map(({ channel, listen }) => {
    const listener = listen(targets, deps);
    ipc.on(channel, listener);
    return { channel, listener };
  });
  return () => {
    for (const { channel, listener } of registered) {
      ipc.removeListener(channel, listener);
    }
  };
}
