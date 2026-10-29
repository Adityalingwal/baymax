import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeFlux,
  createHarness,
  end,
  frame,
  hold,
  resolveCall,
  sendAudio,
  words,
} from "./recording.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

function openHarness() {
  const flux = createFakeFlux();
  const h = createHarness(flux);
  flux.open();
  return { flux, h };
}

const pcmOf = (h: ReturnType<typeof createHarness>, call: number) => [
  ...new Uint8Array(h.pending[call].audio, 44),
];

describe("a final that may never come", () => {
  it("restarts the socket when the earlier deadline passes after the later hold's audio already went out, and sends that hold to batch whole", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a, [1]);
    h.flow.holdStarted();
    const b = h.last();
    frame(h, b, 2);
    h.clock.advance(2000);
    // A's not-caught is dropped: the user is already holding again.
    expect(h.heard).toEqual([]);
    frame(h, b, 3);
    expect(flux.sent).toEqual(["audio 1", "endTurn", "audio 2", "restart"]);
    flux.open();
    h.flow.holdEnded("accept");
    end(h, b);
    flux.emit({ kind: "endOfTurn", trigger: "manual", transcript: "stale" });
    expect(pcmOf(h, 0)).toEqual([2, 0, 0, 0, 3, 0, 0, 0]);
    await resolveCall(h, 0, { kind: "words", words: "whole b" });
    expect(h.heard).toEqual([words(b, "whole b")]);
  });
});

describe("a failed Flux send", () => {
  it.each([
    ["an audio send", "audio" as const, ["audio 1", "restart"]],
    [
      "the ForceEndTurn send",
      "endTurn" as const,
      ["audio 1", "audio 2", "restart"],
    ],
  ])(
    "restarts the socket after %s fails and sends the utterance to batch whole",
    async (_name, which, sent) => {
      const { flux, h } = openHarness();
      h.flow.holdStarted();
      const id = h.last();
      frame(h, id, 1);
      if (which === "audio") flux.failSends("audio");
      frame(h, id, 2);
      if (which === "endTurn") flux.failSends("endTurn");
      h.flow.holdEnded("accept");
      end(h, id);
      expect(flux.sent).toEqual(sent);
      expect(pcmOf(h, 0)).toEqual([1, 0, 0, 0, 2, 0, 0, 0]);
      await resolveCall(h, 0, { kind: "words", words: "batch" });
      expect(h.heard).toEqual([words(id, "batch")]);
    },
  );
});
