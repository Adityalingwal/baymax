import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FluxEvent } from "../providers/flux";
import {
  createFakeFlux,
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

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const manual = (transcript: string): FluxEvent => ({
  kind: "endOfTurn",
  trigger: "manual",
  transcript,
});
const timeout = (transcript: string): FluxEvent => ({
  kind: "endOfTurn",
  trigger: "timeout",
  transcript,
});
const update = (transcript: string): FluxEvent => ({
  kind: "update",
  transcript,
});

function openHarness() {
  const flux = createFakeFlux();
  const h = createHarness(flux);
  flux.open();
  return { flux, h };
}

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
  heard: string | null; // the words, or null for not caught
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
  {
    name: "the no-turn warning alone",
    events: [{ kind: "noActiveTurn" }],
    heard: null,
  },
  { name: "an empty manual end of turn", events: [manual("  ")], heard: null },
];

describe("turn binding (L3b, L5)", () => {
  it.each(bindingRows)("$name", ({ events, heard }) => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    sendAudio(h, id);
    events.forEach(flux.emit);
    expect(h.heard).toEqual([
      heard === null ? missed(id, "empty") : words(id, heard),
    ]);
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

describe("the deadline (L5, L8)", () => {
  it("uses the kept texts and the latest update 2 s after release, then drops the late final", () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    flux.emit(timeout("one"));
    flux.emit(update("two"));
    h.clock.advance(1999);
    expect(h.heard).toEqual([]);
    h.clock.advance(1);
    expect(h.heard).toEqual([words(a, "one two")]);
    const b = hold(h, "accept");
    sendAudio(h, b);
    flux.emit(manual("one two three"));
    flux.emit(manual("next question"));
    expect(h.heard).toEqual([words(a, "one two"), words(b, "next question")]);
  });

  it("is not caught when nothing was heard by the deadline", () => {
    const { h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    h.clock.advance(2000);
    expect(h.heard).toEqual([missed(a, "empty")]);
  });
});

describe("discarded holds (L6)", () => {
  it("still ends the Flux turn at once and drops its transcript", () => {
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
    flux.emit(manual("real question"));
    expect(flux.sent).toEqual(["audio 1", "endTurn", "audio 3", "endTurn"]);
    expect(h.heard).toEqual([words(b, "real question")]);
  });

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
      1, 0, 0, 0, 2, 0, 0, 0,
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
      1, 0, 0, 0, 2, 0, 0, 0,
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

  it("never sends an utterance resolved by its deadline to batch", async () => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    sendAudio(h, id);
    flux.emit(update("in time"));
    h.clock.advance(2000);
    flux.close();
    await flush();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.heard).toEqual([words(id, "in time")]);
  });
});
