import { describe, expect, it } from "vitest";
import type { SaidLine } from "./tasks/state";
import {
  audio,
  createHarness,
  failed,
  hold,
  sendClip,
  synthesized,
} from "./voice.harness";

const line = (text: string): SaidLine => ({
  taskId: "t1",
  text,
  kind: "answer",
});

describe("voice before start", () => {
  it("ignores state calls but already speaks and silences", () => {
    const h = createHarness({ started: false });
    h.voice.holdChanged("listening", null);
    h.voice.holdChanged("idle", "accept");
    h.voice.clipArrived({
      utteranceId: "u1",
      outcome: "failed",
      reason: "error",
    });
    h.voice.setMuted(true);
    expect(h.recordings).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([
      "hold change before start: ignored",
      "hold change before start: ignored",
      "clip before start: ignored",
      "mute before start: ignored",
    ]);
    h.voice.say(line("Hello."));
    expect(h.syntheses.map((call) => call.text)).toEqual(["Hello."]);
    h.voice.silence("t1");
    h.voice.say(line("Again."));
    expect(h.syntheses).toHaveLength(1);
  });

  it("tells main a voice change that came before start", async () => {
    const h = createHarness({ started: false });
    h.voice.say(line("Hello."));
    await synthesized(h, 0, failed("unreachable"));
    expect(h.calls).toEqual([]);
    h.voice.start(h.state);
    expect(h.calls).toEqual(["voiceAvailable false"]);
  });
});

describe("hold routing", () => {
  it("silences speech before the recording starts", async () => {
    const h = createHarness();
    h.voice.say(line("Hello."));
    await synthesized(h, 0, audio);
    expect(h.speeches).toHaveLength(1);
    h.voice.holdChanged("listening", null);
    expect(h.timeline).toEqual(["stop playback", "recording start"]);
  });

  it("stops the recording at release, then lets speech resume", () => {
    const h = createHarness();
    h.voice.holdChanged("listening", null);
    h.voice.say(line("Hello."));
    expect(h.syntheses).toHaveLength(0);
    h.voice.holdChanged("idle", "accept");
    expect(h.recordings.map((command) => command.type)).toEqual([
      "start",
      "stop",
    ]);
    expect(h.syntheses).toHaveLength(1);
  });

  it("keeps working when the recording send throws", () => {
    const h = createHarness();
    h.control.recordingFails = true;
    expect(() => {
      h.voice.holdChanged("listening", null);
      h.voice.holdChanged("idle", "accept");
    }).not.toThrow();
    expect(h.logs).toEqual([
      "sendRecording threw: Error: window gone",
      "sendRecording threw: Error: window gone",
    ]);
  });
});

describe("mute", () => {
  it("reaches main's state and speech", async () => {
    const h = createHarness();
    h.voice.setMuted(true);
    h.voice.say(line("Hello."));
    expect(h.calls).toEqual(["muted true"]);
    expect(h.syntheses).toHaveLength(0);
    h.voice.setMuted(false);
    h.voice.say(line("Again."));
    expect(h.calls).toEqual(["muted true", "muted false"]);
    expect(h.syntheses.map((call) => call.text)).toEqual(["Again."]);
  });
});

const timing = (h: ReturnType<typeof createHarness>) =>
  h.logs.filter((message) => message.startsWith("first spoken line"));

describe("time to the first spoken line", () => {
  it("logs the time from release to the first line once", async () => {
    const h = createHarness();
    h.control.now = 1000;
    sendClip(h, hold(h));
    h.voice.say(line("Let me check."));
    h.control.now = 2480.4;
    await synthesized(h, 0, audio);
    h.voice.playbackFinished({
      lineId: h.speeches[0].lineId,
      outcome: "ended",
    });
    h.voice.say(line("The answer."));
    await synthesized(h, 1, audio);
    expect(h.speeches).toHaveLength(2);
    expect(timing(h)).toEqual(["first spoken line 1480 ms after release"]);
  });

  it("is cleared by a new hold", async () => {
    const h = createHarness();
    hold(h);
    h.voice.holdChanged("listening", null);
    h.voice.holdChanged("idle", "discard");
    h.voice.say(line("Hello."));
    await synthesized(h, 0, audio);
    expect(h.speeches).toHaveLength(1);
    expect(timing(h)).toEqual([]);
  });
});
