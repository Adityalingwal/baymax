import { beforeEach, describe, expect, it, vi } from "vitest";
import "./preload";
import { ipcChannels } from "./shared/ipc";
import type { BaymaxApi } from "./shared/ipc";

type Listener = (event: unknown, payload: unknown) => void;

const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  const exposed: { key: string; api: unknown } = { key: "", api: null };
  const ipcRenderer = {
    on: vi.fn((channel: string, listener: Listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener);
    }),
    send: vi.fn(),
    invoke: vi.fn(),
  };
  const contextBridge = {
    exposeInMainWorld: vi.fn((key: string, api: unknown) => {
      exposed.key = key;
      exposed.api = api;
    }),
  };
  const emit = (channel: string, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) {
      listener({ sender: "electron-event" }, payload);
    }
  };
  return { ipcRenderer, contextBridge, exposed, emit };
});

vi.mock("electron", () => ({
  ipcRenderer: fake.ipcRenderer,
  contextBridge: fake.contextBridge,
}));

const api = fake.exposed.api as BaymaxApi;

beforeEach(() => {
  fake.ipcRenderer.on.mockClear();
  fake.ipcRenderer.send.mockClear();
  fake.ipcRenderer.invoke.mockReset();
});

describe("preload bridge", () => {
  it("exposes the api as window.baymax", () => {
    expect(fake.exposed.key).toBe("baymax");
  });
});

type ActionRow = {
  name: string;
  act: () => void;
  expected: unknown[];
};

const taskAction = { taskId: "t1" };
const audio = new ArrayBuffer(4);

const actionRows: ActionRow[] = [
  {
    name: "submitQuestion",
    act: () => api.submitQuestion({ text: "how does Hermes work" }),
    expected: [ipcChannels.submitQuestion, { text: "how does Hermes work" }],
  },
  {
    name: "answerQuestion",
    act: () =>
      api.answerQuestion({
        taskId: "t1",
        questionId: "q1",
        reply: { kind: "choice", index: 0 },
      }),
    expected: [
      ipcChannels.answerQuestion,
      { taskId: "t1", questionId: "q1", reply: { kind: "choice", index: 0 } },
    ],
  },
  {
    name: "cancelTask",
    act: () => api.cancelTask(taskAction),
    expected: [ipcChannels.cancelTask, taskAction],
  },
  {
    name: "retryTask",
    act: () => api.retryTask(taskAction),
    expected: [ipcChannels.retryTask, taskAction],
  },
  {
    name: "closeCard",
    act: () => api.closeCard(taskAction),
    expected: [ipcChannels.closeCard, taskAction],
  },
  {
    name: "setCardFolded",
    act: () => api.setCardFolded({ taskId: "t1", folded: true }),
    expected: [ipcChannels.setCardFolded, { taskId: "t1", folded: true }],
  },
  {
    name: "openSource",
    act: () => api.openSource({ taskId: "t1", url: "https://example.com" }),
    expected: [
      ipcChannels.openSource,
      { taskId: "t1", url: "https://example.com" },
    ],
  },
  {
    name: "setMuted",
    act: () => api.setMuted({ muted: true }),
    expected: [ipcChannels.setMuted, { muted: true }],
  },
  {
    name: "sendClip",
    act: () =>
      api.sendClip({
        utteranceId: "u1",
        outcome: "recorded",
        audio,
        mimeType: "audio/webm",
      }),
    expected: [
      ipcChannels.sendClip,
      { utteranceId: "u1", outcome: "recorded", audio, mimeType: "audio/webm" },
    ],
  },
  {
    name: "reportPlaybackFinished",
    act: () => api.reportPlaybackFinished({ lineId: "l1", outcome: "ended" }),
    expected: [
      ipcChannels.playbackFinished,
      { lineId: "l1", outcome: "ended" },
    ],
  },
  {
    name: "openAccessibilitySettings",
    act: () => api.openAccessibilitySettings(),
    expected: [ipcChannels.openAccessibilitySettings],
  },
];

describe("preload actions", () => {
  it.each(actionRows)(
    "$name sends on its own channel with the payload unchanged",
    ({ act, expected }) => {
      act();
      expect(fake.ipcRenderer.send.mock.calls).toEqual([expected]);
    },
  );
});

type SubscriptionRow = {
  name: string;
  subscribe: (callback: (payload: unknown) => void) => () => void;
  channel: string;
  payload: unknown;
  replay: unknown[][];
};

const subscriptionRows: SubscriptionRow[] = [
  {
    name: "onHoldState",
    subscribe: (callback) => api.onHoldState(callback),
    channel: ipcChannels.holdState,
    payload: "listening",
    replay: [[ipcChannels.getHoldState]],
  },
  {
    name: "onDisplayState",
    subscribe: (callback) => api.onDisplayState(callback),
    channel: ipcChannels.displayState,
    payload: { tasks: [], notice: null, muted: false, voiceAvailable: true },
    replay: [[ipcChannels.getDisplayState]],
  },
  {
    name: "onRecording",
    subscribe: (callback) => api.onRecording(callback),
    channel: ipcChannels.recording,
    payload: { type: "start", utteranceId: "u1" },
    replay: [],
  },
  {
    name: "onSpeech",
    subscribe: (callback) => api.onSpeech(callback),
    channel: ipcChannels.speech,
    payload: { lineId: "l1", audio, mimeType: "audio/mpeg" },
    replay: [],
  },
  {
    name: "onStopPlayback",
    subscribe: (callback) => api.onStopPlayback(callback),
    channel: ipcChannels.stopPlayback,
    payload: { lineId: "l1" },
    replay: [],
  },
];

describe("preload subscriptions", () => {
  it.each(subscriptionRows)(
    "$name passes the payload without the event, and a cleanup stops only its own listener",
    ({ subscribe, channel, payload }) => {
      const first = vi.fn();
      const second = vi.fn();
      const cleanupFirst = subscribe(first);
      const cleanupSecond = subscribe(second);

      fake.emit(channel, payload);
      expect(first.mock.calls).toEqual([[payload]]);

      cleanupFirst();
      fake.emit(channel, payload);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);

      cleanupSecond();
      fake.emit(channel, payload);
      expect(second).toHaveBeenCalledTimes(2);
    },
  );

  it.each(subscriptionRows)(
    "$name asks main for a replay only when the state is current, after its listener is attached",
    ({ subscribe, replay }) => {
      const cleanup = subscribe(vi.fn());
      expect(fake.ipcRenderer.send.mock.calls).toEqual(replay);
      const attached = fake.ipcRenderer.on.mock.invocationCallOrder;
      const asked = fake.ipcRenderer.send.mock.invocationCallOrder;
      expect(asked.every((order) => order > attached[0])).toBe(true);
      cleanup();
    },
  );
});

describe("preload getStartupInfo", () => {
  it("invokes on its channel and resolves with main's answer", async () => {
    const info = { accessibility: true, holdKeyLabel: "Right Option" };
    fake.ipcRenderer.invoke.mockResolvedValue(info);
    await expect(api.getStartupInfo()).resolves.toEqual(info);
    expect(fake.ipcRenderer.invoke.mock.calls).toEqual([
      [ipcChannels.getStartupInfo],
    ]);
  });
});
