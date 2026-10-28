import { describe, expect, it } from "vitest";
import type { Harness } from "./voice.harness";
import {
  audio,
  createHarness,
  hold,
  sendAudio,
  synthesized,
  transcribed,
} from "./voice.harness";

const texts = (h: Harness) => h.syntheses.map((call) => call.text);

function talkerSays(h: Harness, text: string, key: string): void {
  const line = h.voice.talk({ taskId: "t1", kind: "talk", key });
  line.push(text);
  line.end();
}

describe('"One moment." (L15)', () => {
  it("is said 1.5 s after an accepted release when the talker has not spoken, and the talker's line plays after it", async () => {
    const h = createHarness();
    const id = hold(h);
    h.advance(1499);
    expect(texts(h)).toEqual([]);
    h.advance(1);
    expect(texts(h)).toEqual(["One moment."]);
    await synthesized(h, 0, audio);
    talkerSays(h, "I'll check.", id);
    h.voice.playbackFinished({
      lineId: h.speeches[0].lineId,
      outcome: "ended",
    });
    expect(texts(h)).toEqual(["One moment.", "I'll check."]);
  });

  it("starts on a typed question too", () => {
    const h = createHarness();
    h.voice.submitted("typed:t1");
    h.advance(1500);
    expect(texts(h)).toEqual(["One moment."]);
  });
});

describe('no "One moment."', () => {
  it("is not said once the talker's audio has started", async () => {
    const h = createHarness();
    h.control.now = 1000;
    const id = hold(h);
    talkerSays(h, "Hi there.", id);
    h.control.now = 1640;
    await synthesized(h, 0, audio);
    h.advance(1000);
    expect(texts(h)).toEqual(["Hi there."]);
    expect(h.logs).toContain("talker first audio 640 ms after release");
  });

  it("is not cancelled by another generation's talker audio, nor said after a renderer reset", async () => {
    const h = createHarness();
    hold(h);
    talkerSays(h, "Older reply.", "older");
    await synthesized(h, 0, audio);
    h.advance(1500);
    h.voice.playbackFinished({
      lineId: h.speeches[0].lineId,
      outcome: "ended",
    });
    expect(texts(h)).toEqual(["Older reply.", "One moment."]);
    const second = createHarness();
    hold(second);
    second.voice.rendererReset();
    second.advance(1500);
    expect(texts(second)).toEqual([]);
  });

  it("is not said for a discarded hold", () => {
    const h = createHarness();
    hold(h, "discard");
    h.advance(1500);
    expect(texts(h)).toEqual([]);
  });

  it("is not said when the words were not caught", async () => {
    const h = createHarness();
    sendAudio(h, hold(h));
    await transcribed(h, 0, { kind: "empty" });
    h.advance(1500);
    expect(h.calls).toEqual(["notice wordsNotCaught"]);
    expect(texts(h)).toEqual([]);
  });
});

describe("an older generation during a newer hold", () => {
  it('keeps its timer: its "One moment." waits while the key is held and plays after release', () => {
    const h = createHarness();
    hold(h);
    h.voice.holdChanged("listening", null);
    h.advance(1500);
    expect(texts(h)).toEqual([]);
    h.voice.holdChanged("idle", "discard");
    expect(texts(h)).toEqual(["One moment."]);
  });

  it("keeps its talker line, which waits while the key is held", () => {
    const h = createHarness();
    const id = hold(h);
    h.voice.holdChanged("listening", null);
    talkerSays(h, "Late reply.", id);
    expect(texts(h)).toEqual([]);
    h.voice.holdChanged("idle", "discard");
    expect(texts(h)).toEqual(["Late reply."]);
  });
});

describe("a generation that ends", () => {
  it('drops its "One moment." that waits behind another line, when its words were not caught', async () => {
    const h = createHarness();
    const id = hold(h);
    sendAudio(h, id);
    h.voice.say({ taskId: "t9", text: "Blocker.", kind: "failure" });
    await synthesized(h, 0, audio);
    h.advance(1500);
    await transcribed(h, 0, { kind: "empty" });
    h.voice.playbackFinished({
      lineId: h.speeches[0].lineId,
      outcome: "ended",
    });
    expect(texts(h)).toEqual(["Blocker."]);
  });
});

describe("talker timing", () => {
  const timed = (h: Harness) =>
    h.logs.filter(
      (log) => log.startsWith("talker ") || log.startsWith('"One moment."'),
    );

  it.each([
    { start: "a release", begin: (h: Harness) => hold(h) },
    {
      start: "a typed submit",
      begin: (h: Harness) => {
        h.voice.submitted("typed:t1");
        return "typed:t1";
      },
    },
  ])(
    "logs each talker step and the filler once, in ms after $start",
    async ({ begin }) => {
      const h = createHarness();
      h.control.now = 1000;
      const key = begin(h);
      h.advance(1500);
      h.control.now = 1870;
      await synthesized(h, 0, audio);
      h.control.now = 2000;
      const line = h.voice.talk({ taskId: "t1", kind: "talk", key });
      h.control.now = 2300;
      line.push("");
      line.push("I'll check.");
      line.push(" Then I'll answer.");
      h.control.now = 2600;
      line.end();
      h.voice.playbackFinished({
        lineId: h.speeches[0].lineId,
        outcome: "ended",
      });
      h.control.now = 2900;
      await synthesized(h, 1, audio);
      expect(timed(h)).toEqual([
        '"One moment." first audio 870 ms after release',
        "talker reply asked 1000 ms after release",
        "talker first text 1300 ms after release",
        "talker text ended 1600 ms after release",
        "talker first audio 1900 ms after release",
      ]);
    },
  );
});
