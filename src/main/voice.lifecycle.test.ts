import { describe, expect, it } from "vitest";
import type { SaidLine } from "./tasks/state";
import {
  audio,
  createHarness,
  hold,
  sendAudio,
  synthesized,
  transcribed,
} from "./voice.harness";

const line = (text: string): SaidLine => ({
  taskId: "t1",
  text,
  kind: "answer",
});

describe("renderer reset during a hold", () => {
  it("keeps speech quiet until the key is released", () => {
    const h = createHarness();
    h.voice.holdChanged("listening", null);
    h.voice.rendererReset();
    h.voice.say(line("Hello."));
    expect(h.syntheses).toHaveLength(0);
    h.voice.holdChanged("idle", "accept");
    expect(h.syntheses.map((call) => call.text)).toEqual(["Hello."]);
  });
});

describe("stop", () => {
  it("ends the open recording and ignores later holds and clips", () => {
    const h = createHarness();
    h.voice.holdChanged("listening", null);
    h.voice.stop();
    expect(h.recordings.map((command) => command.type)).toEqual([
      "start",
      "stop",
    ]);
    h.voice.holdChanged("listening", null);
    h.voice.holdChanged("idle", "accept");
    expect(h.recordings).toHaveLength(2);
    expect(h.logs).toContain("hold change after stop: ignored");
  });

  it("drops a transcript that settles after it", async () => {
    const h = createHarness();
    sendAudio(h, hold(h));
    h.voice.stop();
    await transcribed(h, 0, { kind: "words", words: "late" });
    expect(h.asked).toEqual([]);
  });

  it("still speaks, so the restart line can be heard", async () => {
    const h = createHarness();
    h.voice.holdChanged("listening", null);
    h.voice.stop();
    h.voice.say(line("Restarting."));
    await synthesized(h, 0, audio);
    expect(h.speeches).toHaveLength(1);
  });
});

describe("a state throw outside a listener", () => {
  it("goes to the restart path from a transcript", async () => {
    const h = createHarness();
    sendAudio(h, hold(h));
    h.waiting.stateFails = true;
    await transcribed(h, 0, { kind: "words", words: "hello" });
    expect(h.failures).toEqual(["Error: ask broke"]);
  });

  it("goes to the restart path from a speech health change", async () => {
    const h = createHarness();
    h.waiting.stateFails = true;
    h.voice.say(line("Hello."));
    await synthesized(h, 0, {
      kind: "failed",
      cause: "unreachable",
      detail: "",
    });
    expect(h.failures).toEqual(["Error: voice state broke"]);
  });
});
