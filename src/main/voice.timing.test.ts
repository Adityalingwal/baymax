import { describe, expect, it } from "vitest";
import type { Harness } from "./voice.harness";
import { audio, createHarness, hold, synthesized } from "./voice.harness";

const texts = (h: Harness) => h.syntheses.map((call) => call.text);
const timed = (h: Harness) => h.logs.filter((log) => log.startsWith("talker "));

describe("a release while the talker is silent", () => {
  it("says nothing until the talker speaks", () => {
    const h = createHarness();
    hold(h);
    h.advance(5000);
    expect(texts(h)).toEqual([]);
  });
});

describe("talker timing", () => {
  it.each([
    { start: "a release", begin: (h: Harness) => hold(h) },
    {
      start: "a typed submit",
      begin: (h: Harness) => {
        h.voice.submitted("typed:t1");
        return "typed:t1";
      },
    },
  ])("logs each talker step once, in ms after $start", async ({ begin }) => {
    const h = createHarness();
    h.control.now = 1000;
    const key = begin(h);
    h.control.now = 1500;
    const line = h.voice.talk({ taskId: "t1", kind: "talk", key });
    h.control.now = 1800;
    line.push("");
    line.push("I'll check.");
    line.push(" Then I'll answer.");
    h.control.now = 2100;
    line.end();
    h.control.now = 2400;
    await synthesized(h, 0, audio);
    expect(texts(h)).toEqual(["I'll check. Then I'll answer."]);
    expect(timed(h)).toEqual([
      "talker reply asked 500 ms after release",
      "talker first text 800 ms after release",
      "talker text ended 1100 ms after release",
      "talker first audio 1400 ms after release",
    ]);
  });

  it("does not time a line without a generation, nor an older release once 16 newer ones came", async () => {
    const h = createHarness();
    h.voice.submitted("old");
    for (let n = 0; n < 16; n += 1) h.voice.submitted(`typed:${n}`);
    h.voice.talk({ taskId: "t1", kind: "talk", key: "old" }).push("Hi.");
    h.voice.talk({ taskId: "t2", kind: "question", key: null }).push("Which?");
    expect(timed(h)).toEqual([]);
  });
});
