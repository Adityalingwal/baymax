import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FluxEvent } from "../../src/providers/flux";
import {
  createFakeFlux,
  createHarness,
  end,
  frame,
  hold,
  manual,
  micFailed,
  missed,
  openHarness,
  pcmOf,
  resolveCall,
  sendAudio,
  timeout,
  update,
  words,
} from "./recording.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("ending the turn (L4)", () => {
  it("streams frames while held and sends ForceEndTurn only after the end-of-frames marker", () => {
    const { flux, h } = openHarness();
    h.flow.holdStarted();
    const id = h.last();
    frame(h, id, 1);
    frame(h, id, 2);
    h.flow.holdEnded("accept");
    expect(flux.sent).toEqual(["audio 1", "audio 2"]);
    frame(h, id, 3);
    end(h, id);
    expect(flux.sent).toEqual(["audio 1", "audio 2", "audio 3", "endTurn"]);
  });

  it("holds a new hold's frames until the previous turn was ended, so turns never mix", () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    frame(h, a, 1);
    const b = hold(h, "accept");
    frame(h, b, 2);
    expect(flux.sent).toEqual(["audio 1"]);
    end(h, a);
    expect(flux.sent).toEqual(["audio 1", "endTurn", "audio 2"]);
    end(h, b);
    expect(flux.sent).toEqual(["audio 1", "endTurn", "audio 2", "endTurn"]);
  });
});

type BindingRow = {
  name: string;
  events: FluxEvent[];
  heard: string;
};

const bindingRows: BindingRow[] = [
  { name: "a manual end of turn", events: [manual("hello")], heard: "hello" },
  {
    name: "timeout texts joined with the manual one",
    events: [timeout("first part"), update("second"), manual("second part")],
    heard: "first part second part",
  },
  {
    name: "the no-turn warning after a timeout keeps the timeout text",
    events: [timeout("only part"), { kind: "noActiveTurn" }],
    heard: "only part",
  },
];

describe("turn binding (L3b, L5)", () => {
  it.each(bindingRows)("$name", ({ events, heard }) => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    sendAudio(h, id);
    events.forEach(flux.emit);
    expect(h.heard).toEqual([words(id, heard)]);
  });

  it("resolves utterances in the order their audio was sent", () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    const b = hold(h, "accept");
    sendAudio(h, b);
    flux.emit(manual("first"));
    flux.emit(manual("second"));
    expect(h.heard).toEqual([words(a, "first"), words(b, "second")]);
  });
});

describe("discarded holds (L6)", () => {
  it("still ends the Flux turn at once and drops its transcript; the next hold, before the tap's final, goes to a fresh socket", async () => {
    const { flux, h } = openHarness();
    h.flow.holdStarted();
    const tap = h.last();
    frame(h, tap, 1);
    h.flow.holdEnded("discard");
    expect(flux.sent).toEqual(["audio 1", "endTurn"]);
    sendAudio(h, tap, [2]);
    const b = hold(h, "accept");
    sendAudio(h, b, [3]);
    flux.emit(manual("tap words"));
    expect(flux.sent).toEqual(["audio 1", "endTurn", "restart"]);
    await resolveCall(h, 0, { kind: "words", words: "real question" });
    expect(h.heard).toEqual([words(b, "real question")]);
  });

  it("sends the next hold on the same socket once the tap's final came", () => {
    const { flux, h } = openHarness();
    const tap = hold(h, "discard");
    expect(flux.sent).toEqual([]);
    h.flow.holdStarted();
    const first = h.last();
    frame(h, first, 1);
    h.flow.holdEnded("discard");
    flux.emit(manual("tap words"));
    const b = hold(h, "accept");
    sendAudio(h, b, [3]);
    flux.emit(manual("real question"));
    expect(tap).not.toBe(first);
    expect(flux.sent).toEqual(["audio 1", "endTurn", "audio 3", "endTurn"]);
    expect(h.heard).toEqual([words(b, "real question")]);
  });
});

describe("dropped holds that end their turn (L6)", () => {
  it("ends the turn on a renderer reset while recording and drops it", () => {
    const { flux, h } = openHarness();
    h.flow.holdStarted();
    frame(h, h.last(), 1);
    h.flow.rendererReset();
    flux.emit(manual("lost"));
    expect(flux.sent).toEqual(["audio 1", "endTurn"]);
    expect(h.heard).toEqual([]);
  });

  it("ends the turn of a hold whose mic failed after frames went out", () => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    frame(h, id, 1);
    micFailed(h, id, "error");
    flux.emit(manual("half"));
    expect(flux.sent).toEqual(["audio 1", "endTurn"]);
    expect(h.heard).toEqual([missed(id, "error")]);
  });
});

describe("a dead socket (L7)", () => {
  it("reconnects at once at key-down and sends the buffered frames in order when it opens", () => {
    const flux = createFakeFlux();
    const h = createHarness(flux);
    h.flow.holdStarted();
    const id = h.last();
    frame(h, id, 1);
    frame(h, id, 2);
    flux.open();
    frame(h, id, 3);
    h.flow.holdEnded("accept");
    end(h, id);
    expect(flux.sent).toEqual([
      "connectNow",
      "audio 1",
      "audio 2",
      "audio 3",
      "endTurn",
    ]);
  });
});

describe("the batch fallback (L7)", () => {
  it("sends the whole utterance to batch once when the socket is still closed at its end", async () => {
    const flux = createFakeFlux();
    const h = createHarness(flux);
    const id = hold(h, "accept");
    sendAudio(h, id, [1, 2]);
    flux.open();
    await resolveCall(h, 0, { kind: "words", words: "batch words" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(h.pending[0].audio, 44)]).toEqual([
      1, 0, 0, 16, 2, 0, 0, 16,
    ]);
    expect(flux.sent).toEqual(["connectNow"]);
    expect(h.heard).toEqual([words(id, "batch words")]);
  });

  it("drops Flux results of a socket that closed after some frames, and sends the utterance to batch at its end", async () => {
    const { flux, h } = openHarness();
    h.flow.holdStarted();
    const id = h.last();
    frame(h, id, 1);
    flux.close();
    flux.open();
    frame(h, id, 2);
    h.flow.holdEnded("accept");
    end(h, id);
    flux.emit(manual("stale"));
    await resolveCall(h, 0, { kind: "words", words: "whole clip" });
    expect(flux.sent).toEqual(["audio 1"]);
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(h.pending[0].audio, 44)]).toEqual([
      1, 0, 0, 16, 2, 0, 0, 16,
    ]);
    expect(h.heard).toEqual([words(id, "whole clip")]);
  });
});

describe("a socket that closes mid-utterance (L7)", () => {
  it("sends an ended utterance to batch at once when the socket closes before its final", async () => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    sendAudio(h, id);
    flux.close();
    h.clock.advance(5000);
    expect(h.heard).toEqual([]);
    await resolveCall(h, 0, { kind: "empty" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([missed(id, "empty")]);
  });
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
      expect([...new Uint8Array(h.pending[0].audio, 44)]).toEqual([
        1, 0, 0, 16,
      ]);
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

describe("a final that may never come", () => {
  it("restarts the socket when the earlier deadline passes after the later hold's audio already went out, and sends that hold to batch whole", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a, [1]);
    h.flow.holdStarted();
    const b = h.last();
    frame(h, b, 2);
    h.clock.advance(2000);
    expect(h.heard).toEqual([]);
    frame(h, b, 3);
    expect(flux.sent).toEqual(["audio 1", "endTurn", "audio 2", "restart"]);
    flux.open();
    h.flow.holdEnded("accept");
    end(h, b);
    flux.emit({ kind: "endOfTurn", trigger: "manual", transcript: "stale" });
    expect(pcmOf(h, 1)).toEqual([2, 0, 0, 16, 3, 0, 0, 16]);
    await resolveCall(h, 1, { kind: "words", words: "whole b" });
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
      expect(pcmOf(h, 0)).toEqual([1, 0, 0, 16, 2, 0, 0, 16]);
      await resolveCall(h, 0, { kind: "words", words: "batch" });
      expect(h.heard).toEqual([words(id, "batch")]);
    },
  );
});
