import { describe, expect, it } from "vitest";
import { ipcChannels } from "../shared/ipc";
import { intake, question } from "./tasks/harness";
import {
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
  prepare: (w: Wired) => void;
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
    name: "retry asks the engine again after a failed intake",
    prepare: (w) => {
      submit(w);
      w.port.emit({ type: "failure", taskId: "t1", kind: "modelsUnreachable" });
    },
    channel: ipcChannels.retryTask,
    payload: { taskId: "t1" },
    check: (w) =>
      expect(w.port.sent.map((command) => command.type)).toEqual([
        "question",
        "question",
      ]),
  },
  {
    name: "close removes the done card",
    prepare: runToDone,
    channel: ipcChannels.closeCard,
    payload: { taskId: "t1" },
    check: (w) => expect(w.card("t1")).toBeUndefined(),
  },
  {
    name: "fold folds the done card",
    prepare: runToDone,
    channel: ipcChannels.setCardFolded,
    payload: { taskId: "t1", folded: true },
    check: (w) => expect(w.card("t1")?.folded).toBe(true),
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
  {
    name: "an answer to the shown question goes to the engine",
    prepare: (w) => {
      submit(w);
      w.port.emit(
        intake("t1", {
          route: "clarify",
          sayBack: "about Hermes",
          question: question("q1"),
        }),
      );
    },
    channel: ipcChannels.answerQuestion,
    payload: {
      taskId: "t1",
      questionId: "q1",
      reply: { kind: "choice", index: 0 },
    },
    check: (w) =>
      expect(w.port.sent.at(-1)).toMatchObject({
        type: "clarifyingAnswer",
        taskId: "t1",
        reply: { kind: "choice", index: 0 },
      }),
  },
];

// Valid payloads that would change something, so a foreign sender is shown to be dropped.
const validPayloads: [string, unknown][] = [
  [ipcChannels.getDisplayState, undefined],
  [ipcChannels.submitQuestion, { text: "what is new" }],
  [
    ipcChannels.answerQuestion,
    { taskId: "t1", questionId: "q1", reply: { kind: "choice", index: 0 } },
  ],
  [ipcChannels.cancelTask, { taskId: "t1" }],
  [ipcChannels.retryTask, { taskId: "t1" }],
  [ipcChannels.closeCard, { taskId: "t1" }],
  [ipcChannels.setCardFolded, { taskId: "t1", folded: true }],
  [ipcChannels.openSource, { taskId: "t1", url: source }],
  [ipcChannels.setMuted, { muted: true }],
  [
    ipcChannels.sendClip,
    { utteranceId: "u1", outcome: "failed", reason: "error" },
  ],
  [ipcChannels.playbackFinished, { lineId: "l1", outcome: "ended" }],
];

const answer = (reply: unknown) => ({ taskId: "t1", questionId: "q1", reply });

const malformedPayloads: [string, unknown][] = [
  [ipcChannels.submitQuestion, undefined],
  [ipcChannels.submitQuestion, "what is new"],
  [ipcChannels.submitQuestion, { text: 5 }],
  [ipcChannels.answerQuestion, answer(null)],
  [ipcChannels.answerQuestion, answer({ kind: "text" })],
  [ipcChannels.answerQuestion, answer({ kind: "choice", index: 1.5 })],
  [ipcChannels.answerQuestion, answer({ kind: "voice", text: "first" })],
  [
    ipcChannels.answerQuestion,
    { taskId: "t1", reply: { kind: "text", text: "a" } },
  ],
  [ipcChannels.cancelTask, { taskId: 1 }],
  [ipcChannels.retryTask, null],
  [ipcChannels.closeCard, {}],
  [ipcChannels.setCardFolded, { taskId: "t1", folded: "yes" }],
  [ipcChannels.openSource, { taskId: "t1" }],
  [ipcChannels.setMuted, { muted: "true" }],
  [ipcChannels.sendClip, { outcome: "failed", reason: "error" }],
  [ipcChannels.sendClip, { utteranceId: "u1", outcome: "failed", reason: "x" }],
  [
    ipcChannels.sendClip,
    { utteranceId: "u1", outcome: "recorded", audio: [1, 2], mimeType: "a" },
  ],
  [
    ipcChannels.sendClip,
    { utteranceId: "u1", outcome: "recorded", audio: new ArrayBuffer(2) },
  ],
  [ipcChannels.sendClip, { utteranceId: "u1", outcome: "lost" }],
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
  it.each(actionRows)("$name", ({ prepare, channel, payload, check }) => {
    const w = wire();
    prepare(w);
    w.send(channel, payload);
    check(w);
    expect(w.failures).toEqual([]);
  });

  it.each(dropRows)("drops $name", ({ channel, payload, foreign, reason }) => {
    const w = wire();
    runToDone(w);
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
  });
});
