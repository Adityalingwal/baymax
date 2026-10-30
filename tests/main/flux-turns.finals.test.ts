import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "../../src/providers/deepgram";
import type { FluxEvent } from "../../src/providers/flux";
import type { Heard, NotCaughtCause } from "../../src/main/recording";
import {
  createFakeFlux,
  createHarness,
  end,
  frame,
  hold,
  manual,
  missed,
  openHarness,
  pcmOf,
  quietFrame,
  resolveCall,
  sendAudio,
  timeout,
  update,
  words,
} from "./recording.harness";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const nothingHeard: { name: string; event: FluxEvent }[] = [
  { name: "the no-turn warning", event: { kind: "noActiveTurn" } },
  { name: "an empty manual end of turn", event: manual("  ") },
];

describe.each(nothingHeard)("nothing heard: $name", ({ event }) => {
  it("under the speech level is silent, with no batch call", () => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    quietFrame(h, id);
    end(h, id);
    flux.emit(event);
    expect(h.heard).toEqual([missed(id, "silent")]);
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(flux.sent).not.toContain("restart");
  });

  it("at the speech level gets its words from the held audio", async () => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    sendAudio(h, id, [1, 2]);
    flux.emit(event);
    expect([...new Uint8Array(h.pending[0].audio, 44)]).toEqual([
      1, 0, 0, 16, 2, 0, 0, 16,
    ]);
    await resolveCall(h, 0, { kind: "words", words: "the whisper" });
    expect(h.heard).toEqual([words(id, "the whisper")]);
  });

  it("keeps text from before a timeout, under the speech level too", () => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    quietFrame(h, id);
    end(h, id);
    flux.emit(timeout("kept words"));
    flux.emit(event);
    expect(h.heard).toEqual([words(id, "kept words")]);
  });
});

describe.each(nothingHeard)("speech lost: $name", ({ event }) => {
  it.each<{ name: string; result: Transcription; cause: NotCaughtCause }>([
    { name: "empty too", result: { kind: "empty" }, cause: "empty" },
    {
      name: "failing",
      result: { kind: "failed", cause: "unreachable", detail: "down" },
      cause: "unreachable",
    },
  ])(
    "at the speech level with the batch call $name is not caught",
    async ({ result, cause }) => {
      const { flux, h } = openHarness();
      const id = hold(h, "accept");
      sendAudio(h, id);
      flux.emit(event);
      await resolveCall(h, 0, result);
      expect(h.heard).toEqual([missed(id, cause)]);
    },
  );
});

describe("a speech-level no-turn hold leaves nothing for the next hold", () => {
  it("restarts the socket, so a hold right after it has only its own words", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a, [1]);
    flux.emit({ kind: "noActiveTurn" });
    h.flow.holdStarted();
    const b = h.last();
    frame(h, b, 2);
    flux.open();
    h.flow.holdEnded("accept");
    end(h, b);
    expect(flux.sent).toEqual([
      "audio 1",
      "endTurn",
      "restart",
      "connectNow",
      "audio 2",
      "endTurn",
    ]);
    await resolveCall(h, 0, { kind: "words", words: "the whisper" });
    flux.emit(manual("Hi"));
    expect(h.heard).toEqual([words(a, "the whisper"), words(b, "Hi")]);
  });

  it("sends a hold already on that socket to batch whole", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a, [1]);
    h.flow.holdStarted();
    const b = h.last();
    frame(h, b, 2);
    flux.emit({ kind: "noActiveTurn" });
    frame(h, b, 3);
    h.flow.holdEnded("accept");
    end(h, b);
    expect(pcmOf(h, 1)).toEqual([2, 0, 0, 16, 3, 0, 0, 16]);
    await resolveCall(h, 1, { kind: "words", words: "Hi" });
    expect(h.heard).toEqual([words(b, "Hi")]);
  });
});

type BatchAloneRow = {
  name: string;
  send: (h: ReturnType<typeof createHarness>, id: string) => void;
  result: Transcription;
  heard: (id: string) => Heard;
};

const batchAloneRows: BatchAloneRow[] = [
  {
    name: "silence, batch empty: silent",
    send: quietFrame,
    result: { kind: "empty" },
    heard: (id) => missed(id, "silent"),
  },
  {
    name: "speech level, batch empty: not caught",
    send: (h, id) => frame(h, id),
    result: { kind: "empty" },
    heard: (id) => missed(id, "empty"),
  },
  {
    name: "silence, batch words: the words",
    send: quietFrame,
    result: { kind: "words", words: "soft" },
    heard: (id) => words(id, "soft"),
  },
  {
    name: "silence, batch failed: its own cause",
    send: quietFrame,
    result: { kind: "failed", cause: "noCredit", detail: "402" },
    heard: (id) => missed(id, "noCredit"),
  },
];

describe("a hold whose socket is closed goes to batch alone", () => {
  it.each(batchAloneRows)("$name", async ({ send, result, heard }) => {
    const h = createHarness(createFakeFlux());
    const id = hold(h, "accept");
    send(h, id);
    end(h, id);
    await resolveCall(h, 0, result);
    expect(h.heard).toEqual([heard(id)]);
  });

  it("keeps text from before a timeout when batch is empty", async () => {
    const { flux, h } = openHarness();
    const id = hold(h, "accept");
    frame(h, id);
    flux.emit(timeout("kept words"));
    flux.close();
    end(h, id);
    await resolveCall(h, 0, { kind: "empty" });
    expect(h.heard).toEqual([words(id, "kept words")]);
  });
});

describe("a final later than the deadline", () => {
  it("is never replaced by the partial: the whole clip goes to batch at 2 s", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a, [1, 2]);
    flux.emit(timeout("one"));
    flux.emit(update("two"));
    h.clock.advance(1999);
    expect(h.transcribe).not.toHaveBeenCalled();
    h.clock.advance(1);
    expect(h.heard).toEqual([]);
    expect(pcmOf(h, 0)).toEqual([1, 0, 0, 16, 2, 0, 0, 16]);
    await resolveCall(h, 0, { kind: "words", words: "one two three" });
    flux.emit(manual("one two"));
    expect(h.heard).toEqual([words(a, "one two three")]);
  });

  it("wins when it comes before the batch result, delivered once", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    h.clock.advance(2000);
    flux.emit(manual("from flux"));
    await resolveCall(h, 0, { kind: "words", words: "from batch" });
    expect(h.heard).toEqual([words(a, "from flux")]);
  });

  it("leaves the answer to the batch call when it is empty at speech level, with one call", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a);
    h.clock.advance(2000);
    flux.emit({ kind: "noActiveTurn" });
    expect(h.heard).toEqual([]);
    await resolveCall(h, 0, { kind: "words", words: "from batch" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([words(a, "from batch")]);
  });
});

describe("a final later than the deadline, and what follows", () => {
  it.each<{ name: string; result: Transcription; cause: NotCaughtCause }>([
    { name: "finds nothing", result: { kind: "empty" }, cause: "empty" },
    {
      name: "fails",
      result: { kind: "failed", cause: "error", detail: "500" },
      cause: "error",
    },
  ])(
    "is not caught when the batch call also $name",
    async ({ result, cause }) => {
      const { h } = openHarness();
      const a = hold(h, "accept");
      sendAudio(h, a);
      h.clock.advance(2000);
      await resolveCall(h, 0, result);
      expect(h.heard).toEqual([missed(a, cause)]);
    },
  );

  it("restarts the socket before a later hold's audio while that final is missing, so a late final never lands on it", async () => {
    const { flux, h } = openHarness();
    const a = hold(h, "accept");
    sendAudio(h, a, [1]);
    h.clock.advance(2000);
    await resolveCall(h, 0, { kind: "words", words: "one two three" });
    h.flow.holdStarted();
    const b = h.last();
    frame(h, b, 2);
    flux.emit(manual("one two three"));
    flux.open();
    h.flow.holdEnded("accept");
    end(h, b);
    flux.emit(manual("next question"));
    expect(flux.sent).toEqual([
      "audio 1",
      "endTurn",
      "restart",
      "audio 2",
      "endTurn",
    ]);
    expect(h.heard).toEqual([
      words(a, "one two three"),
      words(b, "next question"),
    ]);
  });
});

describe("frames still coming at the deadline", () => {
  it("waits for the marker, so batch gets the later frames and the question comes once", async () => {
    const { flux, h } = openHarness();
    h.flow.holdStarted();
    const id = h.last();
    frame(h, id, 1);
    h.flow.holdEnded("accept");
    h.clock.advance(2000);
    flux.emit(manual("And"));
    expect(h.transcribe).not.toHaveBeenCalled();
    frame(h, id, 2);
    end(h, id);
    expect(flux.sent).toEqual(["audio 1", "restart"]);
    expect(pcmOf(h, 0)).toEqual([1, 0, 0, 16, 2, 0, 0, 16]);
    await resolveCall(h, 0, { kind: "words", words: "And the whole question" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.heard).toEqual([words(id, "And the whole question")]);
  });

  it("goes to batch with the audio it has at about 5 s when the marker never comes", async () => {
    const { h } = openHarness();
    h.flow.holdStarted();
    const id = h.last();
    frame(h, id, 1);
    h.flow.holdEnded("accept");
    h.clock.advance(4999);
    expect(h.transcribe).not.toHaveBeenCalled();
    h.clock.advance(1);
    await resolveCall(h, 0, { kind: "words", words: "capped" });
    expect(h.heard).toEqual([words(id, "capped")]);
  });
});
