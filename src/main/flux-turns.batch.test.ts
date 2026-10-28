import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakeFlux,
  createHarness,
  end,
  frame,
  hold,
  missed,
  resolveCall,
  words,
} from "./recording.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("the deadline of an utterance bound for batch", () => {
  it("is not resolved empty at 2 s; it waits for its end marker, then goes to batch", async () => {
    const flux = createFakeFlux();
    const h = createHarness(flux);
    const id = hold(h, "accept");
    frame(h, id, 1);
    h.clock.advance(2000);
    expect(h.heard).toEqual([]);
    end(h, id);
    await resolveCall(h, 0, { kind: "words", words: "late but whole" });
    expect(h.heard).toEqual([words(id, "late but whole")]);
  });

  it.each([
    ["socket closed from the start", false],
    ["socket closed after some frames went out", true],
  ])(
    "with the %s, goes to batch with its PCM at about 5 s when no end marker came",
    async (_name, opened) => {
      const flux = createFakeFlux();
      const h = createHarness(flux);
      if (opened) flux.open();
      const id = hold(h, "accept");
      frame(h, id, 1);
      if (opened) flux.close();
      h.clock.advance(4999);
      expect(h.transcribe).not.toHaveBeenCalled();
      h.clock.advance(1);
      expect([...new Uint8Array(h.pending[0].audio, 44)]).toEqual([1, 0, 0, 0]);
      await resolveCall(h, 0, { kind: "words", words: "capped" });
      expect(h.heard).toEqual([words(id, "capped")]);
    },
  );

  it("is not caught at about 5 s when it has no PCM", () => {
    const flux = createFakeFlux();
    const h = createHarness(flux);
    const id = hold(h, "accept");
    h.clock.advance(5000);
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.heard).toEqual([missed(id, "empty")]);
  });
});
