import type { ClarifyingReply, DisplayState } from "../shared/cards";
import { ipcChannels } from "../shared/ipc";
import type { RendererToMain } from "../shared/ipc";
import type { MainState } from "./tasks/state";

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

type Listen = (state: MainState, deps: ActionDeps) => RendererListener;
type Action = { channel: string; listen: Listen };

// A message from another sender or with a malformed payload is dropped, never thrown into main.
function action<C extends Channel>(
  channel: C,
  read: Reader<C>,
  run: (state: MainState, payload: RendererToMain[C]) => void,
): Action {
  const listen: Listen = (state, deps) => (event, payload) => {
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
    forwardFailure(deps.fail, () => run(state, value));
  };
  return { channel, listen };
}

const replayDisplay: Action = {
  channel: ipcChannels.getDisplayState,
  listen: (state, deps) => (event) => {
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
  action(ipcChannels.submitQuestion, readSubmit, (state, { text }) =>
    state.ask(text, null, state.waitingQuestion()),
  ),
  action(ipcChannels.answerQuestion, readAnswer, (state, payload) =>
    state.answerQuestion(payload),
  ),
  action(ipcChannels.cancelTask, readTaskAction, (state, { taskId }) =>
    state.cancelTask(taskId),
  ),
  action(ipcChannels.retryTask, readTaskAction, (state, { taskId }) =>
    state.retryTask(taskId),
  ),
  action(ipcChannels.closeCard, readTaskAction, (state, { taskId }) =>
    state.closeCard(taskId),
  ),
  action(ipcChannels.setCardFolded, readFold, (state, payload) =>
    state.setCardFolded(payload),
  ),
  action(ipcChannels.openSource, readOpenSource, (state, payload) =>
    state.openSource(payload),
  ),
  action(ipcChannels.setMuted, readMuted, (state, { muted }) =>
    state.setMuted(muted),
  ),
];

// Returns a function that removes every listener it registered.
export function registerRendererActions(
  ipc: RendererIpc,
  state: MainState,
  deps: ActionDeps,
): () => void {
  const registered = actions.map(({ channel, listen }) => {
    const listener = listen(state, deps);
    ipc.on(channel, listener);
    return { channel, listener };
  });
  return () => {
    for (const { channel, listener } of registered) {
      ipc.removeListener(channel, listener);
    }
  };
}
