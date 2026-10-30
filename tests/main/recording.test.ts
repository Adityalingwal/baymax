import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "../../src/providers/deepgram";
import type { UtteranceId } from "../../src/shared/cards";
import {
  createHarness,
  end,
  flush,
  frame,
  hold,
  micFailed,
  missed,
  resolveCall,
  sendAudio,
  words,
} from "./recording.harness";
import type { Heard } from "../../src/main/recording";
import type { Harness } from "./recording.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

type RuleRow = {
  name: string;
  run: (h: Harness) => Promise<UtteranceId>;
  calls: number;
  expected: (utteranceId: UtteranceId) => Heard[];
};

function acceptedThen(result?: Transcription) {
  return async (h: Harness) => {
    const id = hold(h, "accept");
    sendAudio(h, id);
    if (result) await resolveCall(h, 0, result);
    return id;
  };
}

const ruleRows: RuleRow[] = [
  {
    name: "accept + audio -> one transcription and the words",
    run: acceptedThen({ kind: "words", words: "hello" }),
    calls: 1,
    expected: (id) => [words(id, "hello")],
  },
  {
    name: "discard + audio -> no call and nothing heard",
    run: async (h) => {
      const id = hold(h, "discard");
      sendAudio(h, id);
      return id;
    },
    calls: 0,
    expected: () => [],
  },
  ...(["permissionDenied", "noMicrophone", "error"] as const).map((reason) => ({
    name: `accept + mic failure (${reason}) -> not caught with that cause, no call`,
    run: async (h: Harness) => {
      const id = hold(h, "accept");
      micFailed(h, id, reason);
      return id;
    },
    calls: 0,
    expected: (id: UtteranceId) => [missed(id, reason)],
  })),
  {
    name: "accept + an end with no frames -> not caught empty, no call",
    run: async (h) => {
      const id = hold(h, "accept");
      end(h, id);
      return id;
    },
    calls: 0,
    expected: (id) => [missed(id, "empty")],
  },
  {
    name: "an empty transcription -> not caught empty",
    run: acceptedThen({ kind: "empty" }),
    calls: 1,
    expected: (id) => [missed(id, "empty")],
  },
  {
    name: "a failed transcription -> not caught with its cause",
    run: acceptedThen({
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
      const id = await acceptedThen()(h);
      h.pending[0].reject(new Error("boom"));
      await flush();
      return id;
    },
    calls: 1,
    expected: (id) => [missed(id, "error")],
  },
  {
    name: "audio for an unknown id -> nothing",
    run: async (h) => {
      hold(h, "accept");
      sendAudio(h, "unknown");
      return "unknown";
    },
    calls: 0,
    expected: () => [],
  },
  {
    name: "frames and an end after the end -> nothing more",
    run: async (h) => {
      const id = await acceptedThen({ kind: "words", words: "hi" })(h);
      sendAudio(h, id);
      await flush();
      return id;
    },
    calls: 1,
    expected: (id) => [words(id, "hi")],
  },
  {
    name: "a reset while recording, then its audio -> nothing",
    run: async (h) => {
      h.flow.holdStarted();
      const id = h.last();
      h.flow.rendererReset();
      h.flow.holdEnded("accept");
      sendAudio(h, id);
      return id;
    },
    calls: 0,
    expected: () => [],
  },
  {
    name: "an accepted hold, then a reset, then its audio -> nothing",
    run: async (h) => {
      const id = hold(h, "accept");
      h.flow.rendererReset();
      sendAudio(h, id);
      return id;
    },
    calls: 0,
    expected: () => [],
  },
  {
    name: "holdStarted twice -> the first is stopped and its audio dropped",
    run: async (h) => {
      h.flow.holdStarted();
      h.flow.holdStarted();
      const id = h.starts()[0].utteranceId;
      expect(h.sent).toEqual([
        { type: "start", utteranceId: id },
        { type: "stop", utteranceId: id },
        { type: "start", utteranceId: h.starts()[1].utteranceId },
      ]);
      sendAudio(h, id);
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

describe("batch transcription input", () => {
  it("sends the whole held PCM in order as one WAV", () => {
    const h = createHarness();
    const id = hold(h, "accept");
    frame(h, id, 7);
    frame(h, id, 9);
    end(h, id);
    expect(h.pending).toHaveLength(1);
    const { audio, mimeType } = h.pending[0];
    expect(mimeType).toBe("audio/wav");
    expect([...new Uint8Array(audio, 44)]).toEqual([7, 0, 0, 16, 9, 0, 0, 16]);
  });
});

describe("utterances that never resolve", () => {
  it("keeps the places of the last sixteen accepted holds only", async () => {
    const h = createHarness();
    const ids = Array.from({ length: 17 }, () => hold(h, "accept"));
    sendAudio(h, ids[0]);
    sendAudio(h, ids[1]);
    await resolveCall(h, 0, { kind: "words", words: "first" });
    await resolveCall(h, 1, { kind: "words", words: "second" });
    expect(h.heard).toEqual([words(ids[1], "second")]);
  });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

type LateRow = {
  name: string;
  finishA: (h: Harness, a: UtteranceId) => Promise<void>;
};

const lateRows: LateRow[] = [
  {
    name: "an empty transcription",
    finishA: (h) => resolveCall(h, 0, { kind: "empty" }),
  },
  {
    name: "a failed transcription",
    finishA: (h) =>
      resolveCall(h, 0, { kind: "failed", cause: "error", detail: "500" }),
  },
];

describe("late not caught", () => {
  it.each(lateRows)(
    "drops A's not-caught from $name after B's words",
    async ({ finishA }) => {
      const h = createHarness();
      const a = hold(h, "accept");
      sendAudio(h, a);
      const b = hold(h, "accept");
      sendAudio(h, b);
      await resolveCall(h, 1, { kind: "words", words: "newer" });
      await finishA(h, a);
      expect(h.heard).toEqual([words(b, "newer")]);
    },
  );

  it("drops a mic failure that arrives after a newer question's words", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    const b = hold(h, "accept");
    sendAudio(h, b);
    await resolveCall(h, 0, { kind: "words", words: "newer" });
    micFailed(h, a, "noMicrophone");
    expect(h.heard).toEqual([words(b, "newer")]);
  });
});

describe("not caught while a newer hold is open", () => {
  it.each(lateRows)(
    "drops A's not-caught from $name while B is still held",
    async ({ finishA }) => {
      const h = createHarness();
      const a = hold(h, "accept");
      sendAudio(h, a);
      h.flow.holdStarted();
      await finishA(h, a);
      expect(h.heard).toEqual([]);
    },
  );

  it.each([
    { outcome: "accept" as const, said: false },
    { outcome: "discard" as const, said: true },
  ])(
    "says A's held not-caught only when B, held meanwhile, ends as $outcome = $said",
    async ({ outcome, said }) => {
      const h = createHarness();
      const a = hold(h, "accept");
      sendAudio(h, a);
      h.flow.holdStarted();
      await resolveCall(h, 0, { kind: "empty" });
      h.flow.holdEnded(outcome);
      expect(h.heard).toEqual(said ? [missed(a, "empty")] : []);
    },
  );

  it.each(lateRows)(
    "drops A's not-caught from $name while B waits for its words",
    async ({ finishA }) => {
      const h = createHarness();
      const a = hold(h, "accept");
      sendAudio(h, a);
      const b = hold(h, "accept");
      sendAudio(h, b);
      await finishA(h, a);
      await resolveCall(h, 1, { kind: "words", words: "newer" });
      expect(h.heard).toEqual([words(b, "newer")]);
    },
  );
});

describe("late transcript", () => {
  it("drops an older transcript that resolves after a newer question's words", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    const b = hold(h, "accept");
    sendAudio(h, b);
    await resolveCall(h, 1, { kind: "words", words: "second" });
    await resolveCall(h, 0, { kind: "words", words: "first" });
    expect(h.heard).toEqual([words(b, "second")]);
  });

  it("delivers both in order when the older resolves first", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    const b = hold(h, "accept");
    sendAudio(h, b);
    await resolveCall(h, 0, { kind: "words", words: "first" });
    await resolveCall(h, 1, { kind: "words", words: "second" });
    expect(h.heard).toEqual([words(a, "first"), words(b, "second")]);
  });

  it("orders by hold, not by audio arrival", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    const b = hold(h, "accept");
    sendAudio(h, b);
    sendAudio(h, a);
    await resolveCall(h, 1, { kind: "words", words: "first" });
    await resolveCall(h, 0, { kind: "words", words: "second" });
    expect(h.heard).toEqual([words(a, "first"), words(b, "second")]);
  });
});

describe("what never makes a question late", () => {
  it("keeps A when a discarded tap and a not-caught B come between A and its result", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    const tap = hold(h, "discard");
    sendAudio(h, tap);
    const b = hold(h, "accept");
    end(h, b);
    await resolveCall(h, 0, { kind: "words", words: "question" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([missed(b, "empty"), words(a, "question")]);
  });
});

describe("renderer reset", () => {
  it("drops a transcription already in flight", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    h.flow.rendererReset();
    await resolveCall(h, 0, { kind: "words", words: "dropped" });
    expect(h.heard).toEqual([]);
  });

  it("keeps the sequence, so a newer question's words make an older in-flight result late", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    const b = hold(h, "accept");
    sendAudio(h, b);
    await resolveCall(h, 1, { kind: "words", words: "newer" });
    await resolveCall(h, 0, { kind: "words", words: "older" });
    expect(h.heard).toEqual([words(b, "newer")]);
  });
});

describe("a second end while transcribing", () => {
  it("calls transcribe once", async () => {
    const h = createHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    sendAudio(h, a);
    await resolveCall(h, 0, { kind: "words", words: "once" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([words(a, "once")]);
  });
});
