import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "./speech.harness";
import {
  audio,
  createHarness,
  failure,
  finish,
  flush,
  play,
  resolveCall,
  said,
} from "./speech.harness";
import type { VoiceDownCause } from "../../src/main/speech";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("speak plays one line at a time", () => {
  it("the second line is synthesized only after the first finished, each with its own text", async () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    expect(h.texts()).toEqual(["first"]);
    await resolveCall(h, 0, audio(7));
    expect(h.speeches).toHaveLength(1);
    expect([...new Uint8Array(h.speeches[0].audio)]).toEqual([7]);
    expect(h.speeches[0].mimeType).toBe("audio/mpeg");
    expect(h.texts()).toEqual(["first"]);

    finish(h, h.speeches[0].lineId);
    expect(h.texts()).toEqual(["first", "second"]);
    await resolveCall(h, 1, audio(8));
    expect([...new Uint8Array(h.speeches[1].audio)]).toEqual([8]);
    expect(h.speeches[1].lineId).not.toBe(h.speeches[0].lineId);
  });

  it("a late report for an old line never ends the line playing now", async () => {
    const h = createHarness();
    const old = await play(h, said("first"));
    h.speech.holdStarted();
    h.speech.holdEnded();
    const current = await play(h, said("second"));
    h.speech.speak(said("third"));
    h.speech.playbackFinished({ lineId: old, outcome: "stopped" });
    expect(h.texts()).toEqual(["first", "second"]);
    expect(h.timers[1].cancelled).toBe(false);

    finish(h, current);
    expect(h.texts()).toEqual(["first", "second", "third"]);
  });

  it("a failed playback report ends the line, is logged, and the next line plays", async () => {
    const h = createHarness();
    const lineId = await play(h, said("first"));
    h.speech.speak(said("second"));
    h.speech.playbackFinished({ lineId, outcome: "failed" });
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] playback failed"),
    );
  });
});

const endings: { name: string; end: (h: Harness, lineId: string) => void }[] = [
  { name: "finish", end: (h, lineId) => finish(h, lineId) },
  { name: "hold", end: (h) => h.speech.holdStarted() },
  { name: "mute", end: (h) => h.speech.setMuted(true) },
  { name: "cancel", end: (h) => h.speech.cancelTask("t1") },
  { name: "renderer reset", end: (h) => h.speech.rendererReset() },
];

describe("the playback deadline", () => {
  it("is set with exactly 60 000 ms when a line is sent", async () => {
    const h = createHarness();
    await play(h, said("first"));
    expect(h.timers.map((timer) => timer.ms)).toEqual([60_000]);
  });

  it("firing on the stuck line stops it and plays the next", async () => {
    const h = createHarness();
    const lineId = await play(h, said("first"));
    h.speech.speak(said("second"));
    h.timers[0].fire();
    expect(h.stops).toEqual([{ lineId }]);
    expect(h.texts()).toEqual(["first", "second"]);
  });

  it("an old deadline fired after its line ended does nothing", async () => {
    const h = createHarness();
    finish(h, await play(h, said("first")));
    await play(h, said("second"));
    h.speech.speak(said("third"));
    h.timers[0].fire();
    expect(h.stops).toEqual([]);
    expect(h.texts()).toEqual(["first", "second"]);
  });

  it.each(endings)("is cancelled on $name", async ({ end }) => {
    const h = createHarness();
    const lineId = await play(h, said("first"));
    expect(h.timers[0].cancelled).toBe(false);
    end(h, lineId);
    expect(h.timers[0].cancelled).toBe(true);
  });
});

describe("failures in the injected callbacks never escape", () => {
  it("a throwing sendSpeech is logged, ends that line, and the next plays", async () => {
    const h = createHarness();
    h.sendSpeech.mockImplementationOnce(() => {
      throw new Error("window gone");
    });
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    await resolveCall(h, 0);
    expect(h.timers[0].cancelled).toBe(true);
    expect(h.texts()).toEqual(["first", "second"]);
    await resolveCall(h, 1, audio(2));
    expect([...new Uint8Array(h.speeches[0].audio)]).toEqual([2]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] sendSpeech threw"),
    );
  });

  it("a throwing sendStop is logged and the queue goes on", async () => {
    const h = createHarness();
    h.sendStop.mockImplementationOnce(() => {
      throw new Error("window gone");
    });
    await play(h, said("first"));
    h.speech.holdStarted();
    h.speech.holdEnded();
    h.speech.speak(said("second"));
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] sendStop threw"),
    );
  });

  it("a throwing onVoiceAvailable is logged and the queue goes on", async () => {
    const h = createHarness();
    h.onVoiceAvailable.mockImplementationOnce(() => {
      throw new Error("display gone");
    });
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    await resolveCall(h, 0, failure("unreachable"));
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] onVoiceAvailable threw"),
    );
  });
});

describe("failures in the injected timers never escape", () => {
  it("a throwing setTimer is logged, drops that line, and the next is synthesized", async () => {
    const h = createHarness();
    h.setTimer.mockImplementationOnce(() => {
      throw new Error("no timers");
    });
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    await resolveCall(h, 0);
    expect(h.speeches).toEqual([]);
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] setTimer threw"),
    );
  });

  it("a throwing deadline cancel is logged and the next line plays", async () => {
    const h = createHarness();
    h.setTimer.mockImplementationOnce(() => () => {
      throw new Error("timer gone");
    });
    const lineId = await play(h, said("first"));
    h.speech.speak(said("second"));
    expect(() => finish(h, lineId)).not.toThrow();
    expect(h.texts()).toEqual(["first", "second"]);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("[Speech] cancelDeadline threw"),
    );
  });
});

describe("a callback that re-enters", () => {
  it("playbackFinished called from inside sendSpeech ends that line", async () => {
    const h = createHarness();
    h.sendSpeech.mockImplementationOnce((line) =>
      h.speech.playbackFinished({ lineId: line.lineId, outcome: "ended" }),
    );
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    await resolveCall(h, 0);
    expect(h.timers[0].cancelled).toBe(true);
    expect(h.texts()).toEqual(["first", "second"]);
    await resolveCall(h, 1, audio(2));
    expect(h.speeches).toHaveLength(1);
  });
});

describe("renderer reset", () => {
  it("drops the playing line with no stop and the pending lines; a later line plays", async () => {
    const h = createHarness();
    await play(h, said("first"));
    h.speech.speak(said("second"));
    h.speech.rendererReset();
    expect(h.stops).toEqual([]);
    expect(h.timers[0].cancelled).toBe(true);
    h.speech.speak(said("third"));
    expect(h.texts()).toEqual(["first", "third"]);
  });

  it("clears the held key, so a line said afterwards plays at once", () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.speak(said("during the hold"));
    h.speech.rendererReset();
    h.speech.speak(said("after"));
    expect(h.texts()).toEqual(["after"]);
  });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("hold", () => {
  it("nothing is synthesized or sent while held; lines said during the hold play after release", async () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    expect(h.texts()).toEqual([]);
    h.speech.holdEnded();
    expect(h.texts()).toEqual(["first"]);
    await resolveCall(h, 0);
    finish(h, h.speeches[0].lineId);
    expect(h.texts()).toEqual(["first", "second"]);
  });

  it("a second key-down clears again, including lines said during the hold", () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.speak(said("during the first hold"));
    h.speech.holdStarted();
    h.speech.holdEnded();
    expect(h.texts()).toEqual([]);
  });

  it("a release when not held changes nothing", () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    h.speech.holdEnded();
    expect(h.calls[0].signal.aborted).toBe(false);
    expect(h.texts()).toEqual(["first"]);
  });
});

const holdAndMute: { name: string; steps: (h: Harness) => void }[] = [
  {
    name: "hold, then mute",
    steps: (h) => {
      h.speech.holdStarted();
      h.speech.setMuted(true);
    },
  },
  {
    name: "mute, then hold",
    steps: (h) => {
      h.speech.setMuted(true);
      h.speech.holdStarted();
    },
  },
];

describe("mute with hold", () => {
  it.each(holdAndMute)(
    "$name: a release while still muted plays nothing",
    ({ steps }) => {
      const h = createHarness();
      steps(h);
      h.speech.speak(said("while muted"));
      h.speech.holdEnded();
      h.speech.setMuted(false);
      expect(h.texts()).toEqual([]);
    },
  );
});

describe("mute alone", () => {
  it("drops every line said while muted, with no synthesis", () => {
    const h = createHarness();
    h.speech.setMuted(true);
    h.speech.speak(said("while muted"));
    expect(h.synthesize).not.toHaveBeenCalled();
    h.speech.setMuted(false);
    h.speech.speak(said("after"));
    expect(h.texts()).toEqual(["after"]);
  });

  it("unmute replays nothing that was cleared", async () => {
    const h = createHarness();
    await play(h, said("playing"));
    h.speech.speak(said("pending"));
    h.speech.setMuted(true);
    h.speech.setMuted(false);
    expect(h.texts()).toEqual(["playing"]);
    expect(h.speeches).toHaveLength(1);
  });

  it("the same value twice is a no-op", async () => {
    const h = createHarness();
    const lineId = await play(h, said("playing"));
    h.speech.setMuted(false);
    expect(h.stops).toEqual([]);
    h.speech.setMuted(true);
    h.speech.setMuted(true);
    expect(h.stops).toEqual([{ lineId }]);
  });

  it("a line said while held but not muted waits through an unmute until release", () => {
    const h = createHarness();
    h.speech.holdStarted();
    h.speech.setMuted(true);
    h.speech.setMuted(false);
    h.speech.speak(said("held"));
    expect(h.texts()).toEqual([]);
    h.speech.holdEnded();
    expect(h.texts()).toEqual(["held"]);
  });
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const causes: VoiceDownCause[] = ["unreachable", "keyRejected", "noCredit"];

describe.each(causes)("voice down: %s", (cause) => {
  it("is reported once, the next lines still try, and audio brings voice back", async () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    h.speech.speak(said("second"));
    h.speech.speak(said("third"));
    await resolveCall(h, 0, failure(cause));
    expect(h.voice).toEqual([{ available: false, cause }]);
    expect(h.texts()).toEqual(["first", "second"]);

    await resolveCall(h, 1, failure(cause));
    expect(h.voice).toHaveLength(1);
    expect(h.texts()).toEqual(["first", "second", "third"]);

    await resolveCall(h, 2, audio(3));
    expect(h.voice).toEqual([
      { available: false, cause },
      { available: true, cause: null },
    ]);
    expect(h.speeches).toHaveLength(1);

    finish(h, h.speeches[0].lineId);
    h.speech.speak(said("fourth"));
    await resolveCall(h, 3, failure(cause));
    expect(h.voice).toHaveLength(3);
    expect(h.voice[2]).toEqual({ available: false, cause });
  });

  it("an aborted job's audio does not bring voice back; an owning job's does", async () => {
    const h = createHarness();
    h.speech.speak(said("first"));
    await resolveCall(h, 0, failure(cause));
    h.speech.speak(said("second"));
    h.speech.holdStarted();
    await resolveCall(h, 1, audio());
    expect(h.voice).toEqual([{ available: false, cause }]);

    h.speech.holdEnded();
    h.speech.speak(said("third"));
    await resolveCall(h, 2, audio());
    expect(h.voice[1]).toEqual({ available: true, cause: null });
  });
});

const errorRows: {
  name: string;
  throwsAtOnce: boolean;
  fail: (h: Harness) => Promise<void>;
}[] = [
  {
    name: "a failure with cause error",
    throwsAtOnce: false,
    fail: (h) => resolveCall(h, 0, failure("error")),
  },
  {
    name: "a rejected synthesize",
    throwsAtOnce: false,
    fail: (h) => {
      h.calls[0].reject(new TypeError("socket closed"));
      return flush();
    },
  },
  {
    name: "a synthesize that throws synchronously",
    throwsAtOnce: true,
    fail: () => flush(),
  },
];

describe("synthesis errors", () => {
  it.each(errorRows)(
    "$name drops only that line, with no report",
    async ({ throwsAtOnce, fail }) => {
      const h = createHarness();
      if (throwsAtOnce) {
        h.synthesize.mockImplementationOnce(() => {
          throw new Error("boom");
        });
      }
      h.speech.speak(said("first"));
      h.speech.speak(said("second"));
      await fail(h);
      expect(h.voice).toEqual([]);
      expect(h.speeches).toEqual([]);
      expect(h.texts()).toEqual(
        throwsAtOnce ? ["second"] : ["first", "second"],
      );
      await resolveCall(h, h.calls.length - 1, audio(2));
      expect(h.speeches.map((s) => [...new Uint8Array(s.audio)])).toEqual([
        [2],
      ]);
    },
  );
});
