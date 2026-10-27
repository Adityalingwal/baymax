import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import type { Clip, RecordingCommand } from "../shared/ipc";
import type { HoldOutcome } from "./hold";
import { createRecording } from "./recording";
import type { Heard, NotCaughtCause } from "./recording";

type Deferred = {
  resolve: (result: Transcription) => void;
  reject: (error: unknown) => void;
};

function createHarness() {
  const sent: RecordingCommand[] = [];
  const heard: Heard[] = [];
  const pending: Deferred[] = [];
  const transcribe = vi.fn(
    () =>
      new Promise<Transcription>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const flow = createRecording({
    sendRecording: (command) => sent.push(command),
    transcribe,
    onHeard: (result) => heard.push(result),
  });
  const starts = () => sent.filter((command) => command.type === "start");
  return { flow, sent, heard, pending, transcribe, starts };
}

type Harness = ReturnType<typeof createHarness>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function hold(h: Harness, outcome: HoldOutcome): UtteranceId {
  h.flow.holdStarted();
  const utteranceId = h.starts()[h.starts().length - 1].utteranceId;
  h.flow.holdEnded(outcome);
  return utteranceId;
}

function recorded(utteranceId: UtteranceId, bytes = 4): Clip {
  const audio = new ArrayBuffer(bytes);
  return { utteranceId, outcome: "recorded", audio, mimeType: "audio/webm" };
}

function failedClip(
  utteranceId: UtteranceId,
  reason: "permissionDenied" | "noMicrophone" | "error",
): Clip {
  return { utteranceId, outcome: "failed", reason };
}

async function resolveCall(h: Harness, index: number, result: Transcription) {
  h.pending[index].resolve(result);
  await flush();
}

const words = (utteranceId: UtteranceId, text: string): Heard => ({
  kind: "words",
  utteranceId,
  words: text,
});

const missed = (utteranceId: UtteranceId, cause: NotCaughtCause): Heard => ({
  kind: "notCaught",
  utteranceId,
  cause,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

type RuleRow = {
  name: string;
  run: (h: Harness) => Promise<UtteranceId>;
  calls: number;
  expected: (utteranceId: UtteranceId) => Heard[];
};

function acceptedThen(clip: (id: UtteranceId) => Clip, result?: Transcription) {
  return async (h: Harness) => {
    const id = hold(h, "accept");
    h.flow.clipArrived(clip(id));
    if (result) await resolveCall(h, 0, result);
    return id;
  };
}

const ruleRows: RuleRow[] = [
  {
    name: "accept + recorded clip -> one transcription and the words",
    run: acceptedThen(recorded, { kind: "words", words: "hello" }),
    calls: 1,
    expected: (id) => [words(id, "hello")],
  },
  {
    name: "discard + recorded clip -> no call and nothing heard",
    run: async (h) => {
      const id = hold(h, "discard");
      h.flow.clipArrived(recorded(id));
      return id;
    },
    calls: 0,
    expected: () => [],
  },
  ...(["permissionDenied", "noMicrophone", "error"] as const).map((reason) => ({
    name: `accept + failed clip (${reason}) -> not caught with that cause, no call`,
    run: acceptedThen((id) => failedClip(id, reason)),
    calls: 0,
    expected: (id: UtteranceId) => [missed(id, reason)],
  })),
  {
    name: "accept + zero-byte clip -> not caught empty, no call",
    run: acceptedThen((id) => recorded(id, 0)),
    calls: 0,
    expected: (id) => [missed(id, "empty")],
  },
  {
    name: "an empty transcription -> not caught empty",
    run: acceptedThen(recorded, { kind: "empty" }),
    calls: 1,
    expected: (id) => [missed(id, "empty")],
  },
  {
    name: "a failed transcription -> not caught with its cause",
    run: acceptedThen(recorded, {
      kind: "failed",
      cause: "unreachable",
      detail: "TypeError: fetch failed",
    }),
    calls: 1,
    expected: (id) => [missed(id, "unreachable")],
  },
  {
    name: "a rejected transcription -> not caught error",
    run: async (h) => {
      const id = await acceptedThen(recorded)(h);
      h.pending[0].reject(new Error("boom"));
      await flush();
      return id;
    },
    calls: 1,
    expected: (id) => [missed(id, "error")],
  },
  {
    name: "a clip for an unknown id -> nothing",
    run: async (h) => {
      hold(h, "accept");
      h.flow.clipArrived(recorded("unknown"));
      return "unknown";
    },
    calls: 0,
    expected: () => [],
  },
  {
    name: "a second clip for the same id -> nothing more",
    run: async (h) => {
      const id = await acceptedThen(recorded, { kind: "words", words: "hi" })(
        h,
      );
      h.flow.clipArrived(recorded(id));
      await flush();
      return id;
    },
    calls: 1,
    expected: (id) => [words(id, "hi")],
  },
  {
    name: "a reset while recording, then its clip -> nothing",
    run: async (h) => {
      h.flow.holdStarted();
      const id = h.starts()[0].utteranceId;
      h.flow.rendererReset();
      h.flow.holdEnded("accept");
      h.flow.clipArrived(recorded(id));
      return id;
    },
    calls: 0,
    expected: () => [],
  },
  {
    name: "holdStarted twice -> the first is stopped and its clip dropped",
    run: async (h) => {
      h.flow.holdStarted();
      h.flow.holdStarted();
      const id = h.starts()[0].utteranceId;
      expect(h.sent).toEqual([
        { type: "start", utteranceId: id },
        { type: "stop", utteranceId: id },
        { type: "start", utteranceId: h.starts()[1].utteranceId },
      ]);
      h.flow.clipArrived(recorded(id));
      return id;
    },
    calls: 0,
    expected: () => [],
  },
];

describe("recording flow per-utterance rules", () => {
  it.each(ruleRows)("$name", async ({ run, calls, expected }) => {
    const h = createHarness();
    const id = await run(h);
    await flush();
    expect(h.transcribe).toHaveBeenCalledTimes(calls);
    expect(h.heard).toEqual(expected(id));
  });
});

describe("recording commands", () => {
  it("sends start then stop with one new id per hold", () => {
    const h = createHarness();
    const first = hold(h, "accept");
    const second = hold(h, "discard");
    expect(first).not.toBe(second);
    expect(h.sent).toEqual([
      { type: "start", utteranceId: first },
      { type: "stop", utteranceId: first },
      { type: "start", utteranceId: second },
      { type: "stop", utteranceId: second },
    ]);
  });
});

describe("late transcript", () => {
  it("drops an older transcript that resolves after a newer question's words", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    await resolveCall(h, 1, { kind: "words", words: "second" });
    await resolveCall(h, 0, { kind: "words", words: "first" });
    expect(h.heard).toEqual([words(b, "second")]);
  });

  it("delivers both in order when the older resolves first", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    await resolveCall(h, 0, { kind: "words", words: "first" });
    await resolveCall(h, 1, { kind: "words", words: "second" });
    expect(h.heard).toEqual([words(a, "first"), words(b, "second")]);
  });

  it("orders by hold, not by clip arrival", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    h.flow.clipArrived(recorded(a));
    await resolveCall(h, 1, { kind: "words", words: "first" });
    await resolveCall(h, 0, { kind: "words", words: "second" });
    expect(h.heard).toEqual([words(a, "first"), words(b, "second")]);
  });
});

describe("what never makes a question late", () => {
  it("keeps A when a discarded tap and a not-caught B come between A and its result", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    const tap = hold(h, "discard");
    h.flow.clipArrived(recorded(tap));
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b, 0));
    await resolveCall(h, 0, { kind: "words", words: "question" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([missed(b, "empty"), words(a, "question")]);
  });
});

describe("renderer reset", () => {
  it("still delivers a transcription already in flight", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    h.flow.rendererReset();
    await resolveCall(h, 0, { kind: "words", words: "kept" });
    expect(h.heard).toEqual([words(a, "kept")]);
  });

  it("keeps the sequence, so a newer question's words make an older in-flight result late", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    h.flow.rendererReset();
    const b = hold(h, "accept");
    h.flow.clipArrived(recorded(b));
    await resolveCall(h, 1, { kind: "words", words: "newer" });
    await resolveCall(h, 0, { kind: "words", words: "older" });
    expect(h.heard).toEqual([words(b, "newer")]);
  });
});

describe("duplicate clip while transcribing", () => {
  it("calls transcribe once", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    h.flow.clipArrived(recorded(a));
    h.flow.clipArrived(recorded(a));
    await resolveCall(h, 0, { kind: "words", words: "once" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([words(a, "once")]);
  });
});
