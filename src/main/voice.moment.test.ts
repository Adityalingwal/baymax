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

function talkerSays(h: Harness, text: string): void {
  const line = h.voice.talk({ taskId: "t1", kind: "talk" });
  line.push(text);
  line.end();
}

describe('"One moment." (L15)', () => {
  it("is said 1.5 s after an accepted release when the talker has not spoken, and the talker's line plays after it", async () => {
    const h = createHarness();
    hold(h);
    h.advance(1499);
    expect(texts(h)).toEqual([]);
    h.advance(1);
    expect(texts(h)).toEqual(["One moment."]);
    talkerSays(h, "I'll check.");
    await synthesized(h, 0, audio);
    h.voice.playbackFinished({
      lineId: h.speeches[0].lineId,
      outcome: "ended",
    });
    expect(texts(h)).toEqual(["One moment.", "I'll check."]);
  });

  it("starts on a typed question too", () => {
    const h = createHarness();
    h.voice.submitted();
    h.advance(1500);
    expect(texts(h)).toEqual(["One moment."]);
  });
});

describe('no "One moment."', () => {
  it("is not said once the talker's audio has started", async () => {
    const h = createHarness();
    hold(h);
    talkerSays(h, "Hi there.");
    h.advance(1000);
    await synthesized(h, 0, audio);
    h.advance(1000);
    expect(texts(h)).toEqual(["Hi there."]);
  });

  it("is not said for a discarded hold, nor once a new hold starts", () => {
    const h = createHarness();
    hold(h, "discard");
    h.advance(1500);
    hold(h);
    h.voice.holdChanged("listening", null);
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
