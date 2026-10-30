import { describe, expect, it } from "vitest";
import { ipcChannels } from "../shared/ipc";
import { findings } from "./tasks/harness";
import {
  admitAs,
  failFront,
  fakeSender,
  admitTask,
  runToDone,
  source,
  submit,
  wire,
} from "./wiring.harness";
import type { Wired } from "./wiring.harness";

type ActionRow = {
  name: string;
  prepare: (w: Wired) => void | Promise<void>;
  channel: string;
  payload: unknown;
  check: (w: Wired) => void;
};

const actionRows: ActionRow[] = [
  {
    name: "cancel sends the engine a cancel",
    prepare: admitTask,
    channel: ipcChannels.cancelTask,
    payload: { taskId: "t1" },
    check: (w) =>
      expect(w.port.sent.at(-1)).toEqual({ type: "cancel", taskId: "t1" }),
  },
  {
    name: "retry asks the front call again after a failed one",
    prepare: async (w) => {
      submit(w);
      await failFront(w);
    },
    channel: ipcChannels.retryTask,
    payload: { taskId: "t1" },
    check: (w) => {
      expect(w.talkerCalls).toHaveLength(2);
      expect(w.port.sent).toEqual([]);
    },
  },
  {
    name: "open source opens a listed source",
    prepare: runToDone,
    channel: ipcChannels.openSource,
    payload: { taskId: "t1", url: source },
    check: (w) => expect(w.opened).toEqual([source]),
  },
  {
    name: "mute is published",
    prepare: () => undefined,
    channel: ipcChannels.setMuted,
    payload: { muted: true },
    check: (w) => expect(w.published.at(-1)?.muted).toBe(true),
  },
];

// Valid payloads that would change something, so a foreign sender is shown to be dropped.
const validPayloads: [string, unknown][] = [
  [ipcChannels.getDisplayState, undefined],
  [ipcChannels.submitQuestion, { text: "what is new" }],
  [ipcChannels.cancelTask, { taskId: "t1" }],
  [ipcChannels.retryTask, { taskId: "t1" }],
  [ipcChannels.openSource, { taskId: "t1", url: source }],
  [ipcChannels.setMuted, { muted: true }],
  [
    ipcChannels.micAudio,
    { type: "failed", utteranceId: "u1", reason: "error" },
  ],
  [ipcChannels.playbackFinished, { lineId: "l1", outcome: "ended" }],
];

const malformedPayloads: [string, unknown][] = [
  [ipcChannels.submitQuestion, undefined],
  [ipcChannels.submitQuestion, "what is new"],
  [ipcChannels.submitQuestion, { text: 5 }],
  [ipcChannels.cancelTask, { taskId: 1 }],
  [ipcChannels.retryTask, null],
  [ipcChannels.openSource, { taskId: "t1" }],
  [ipcChannels.setMuted, { muted: "true" }],
  [ipcChannels.micAudio, { type: "failed", reason: "error" }],
  [ipcChannels.micAudio, { type: "failed", utteranceId: "u1", reason: "x" }],
  [ipcChannels.micAudio, { type: "frames", utteranceId: "u1", pcm: [1, 2] }],
  [ipcChannels.micAudio, { type: "frames", utteranceId: "u1" }],
  [ipcChannels.micAudio, { type: "lost", utteranceId: "u1" }],
  [ipcChannels.playbackFinished, { lineId: "l1", outcome: "paused" }],
  [ipcChannels.playbackFinished, { outcome: "ended" }],
];

const dropRows = [
  ...validPayloads.map(([channel, payload]) => ({
    name: `${channel} from another sender`,
    channel,
    payload,
    foreign: true,
    reason: "not from the Baymax window",
  })),
  ...malformedPayloads.map(([channel, payload]) => ({
    name: `${channel} with ${JSON.stringify(payload) ?? "no payload"}`,
    channel,
    payload,
    foreign: false,
    reason: "malformed payload",
  })),
];

describe("renderer actions", () => {
  it.each(actionRows)("$name", async ({ prepare, channel, payload, check }) => {
    const w = wire();
    await prepare(w);
    w.send(channel, payload);
    check(w);
    expect(w.failures).toEqual([]);
  });

  it.each(dropRows)(
    "drops $name",
    async ({ channel, payload, foreign, reason }) => {
      const w = wire();
      await runToDone(w);
      const other = fakeSender();
      const before = [w.port.sent.length, w.published.length, w.opened.length];
      expect(() =>
        w.send(channel, payload, foreign ? other.sender : w.own.sender),
      ).not.toThrow();
      expect([w.port.sent.length, w.published.length, w.opened.length]).toEqual(
        before,
      );
      expect(other.received).toEqual([]);
      expect(w.own.received).toEqual([]);
      expect(w.failures).toEqual([]);
      expect(w.logs.at(-1)).toBe(`${channel} dropped: ${reason}`);
    },
  );
});

const finishWith = (w: Wired, taskId: string, urls: string[]) =>
  w.port.emit({
    type: "result",
    taskId,
    spokenLine: "Done.",
    findings: findings("Done.", urls),
  });

async function threeTasks(): Promise<Wired> {
  const w = wire();
  await admitAs(w, "hermes");
  finishWith(w, "t1", ["https://a.com/x", "javascript:alert(1)", "not a url"]);
  await admitAs(w, "rust");
  finishWith(w, "t2", ["https://b.com/y"]);
  await admitAs(w, "zig");
  return w;
}

const refusedRows = [
  { name: "another URL", taskId: "t1", url: "https://a.com/other" },
  { name: "another task's source", taskId: "t1", url: "https://b.com/y" },
  {
    name: "a listed javascript: URL",
    taskId: "t1",
    url: "javascript:alert(1)",
  },
  {
    name: "a listed string that does not parse",
    taskId: "t1",
    url: "not a url",
  },
  { name: "an unknown task", taskId: "t9", url: "https://a.com/x" },
  { name: "a task with no answer", taskId: "t3", url: "https://a.com/x" },
];

const counts = (w: Wired) => [
  w.published.length,
  w.port.sent.length,
  w.syntheses.length,
];

describe("opening a source", () => {
  it("opens an exact read-source URL of the task and publishes nothing", async () => {
    const w = await threeTasks();
    const before = counts(w);
    w.send(ipcChannels.openSource, { taskId: "t1", url: "https://a.com/x" });
    expect(w.opened).toEqual(["https://a.com/x"]);
    expect(counts(w)).toEqual(before);
  });

  it.each(refusedRows)("refuses $name and logs it", async ({ taskId, url }) => {
    const w = await threeTasks();
    const before = counts(w);
    const logs = w.logs.length;
    w.send(ipcChannels.openSource, { taskId, url });
    expect(w.opened).toEqual([]);
    expect(counts(w)).toEqual(before);
    expect(w.logs.length).toBe(logs + 1);
  });

  it("keeps the allowlist when a published card is changed", async () => {
    const w = await threeTasks();
    w.published.at(-1)?.tasks[0].answer?.sources.push({
      id: "s9",
      url: "https://unread.example",
      title: "unread",
    });
    w.send(ipcChannels.openSource, {
      taskId: "t1",
      url: "https://unread.example",
    });
    expect(w.opened).toEqual([]);
  });
});
