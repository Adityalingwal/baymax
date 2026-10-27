import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import type { Clip } from "../shared/ipc";
import {
  createHarness,
  failedClip,
  flush,
  hold,
  missed,
  recorded,
  resolveCall,
  words,
} from "./recording.harness";
import type { Heard } from "./recording";
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
    name: "an accepted hold, then a reset, then its clip -> nothing",
    run: async (h) => {
      const id = hold(h, "accept");
      h.flow.rendererReset();
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

describe("transcription input", () => {
  it("passes the clip's audio and mime type", () => {
    const h = createHarness();
    const clip = recorded(hold(h, "accept"));
    h.flow.clipArrived(clip);
    if (clip.outcome !== "recorded")
      throw new Error("expected a recorded clip");
    expect(h.transcribe).toHaveBeenCalledWith(clip.audio, clip.mimeType);
  });
});

describe("clips that never come", () => {
  it("keeps the outcomes of the last sixteen holds only", () => {
    const h = createHarness();
    const ids = Array.from({ length: 17 }, () => hold(h, "accept"));
    h.flow.clipArrived(recorded(ids[0]));
    expect(h.transcribe).not.toHaveBeenCalled();
    h.flow.clipArrived(recorded(ids[1]));
    expect(h.transcribe).toHaveBeenCalledTimes(1);
  });
});
