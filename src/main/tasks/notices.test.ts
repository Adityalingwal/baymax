import { describe, expect, it } from "vitest";
import { counts, createHarness } from "./harness";

const notCaught = "I didn't catch that, say it again.";
const voiceLine =
  "Voice isn't working right now. You can type your question instead.";
const restarting = "Baymax hit a problem and is restarting.";

describe("notices", () => {
  it("shows and says a notice every time it is asked", () => {
    const h = createHarness();
    h.state.showNotice("wordsNotCaught");
    h.state.showNotice("wordsNotCaught");
    expect(h.last().notice).toBe(notCaught);
    expect(h.published).toHaveLength(2);
    expect(h.said).toEqual([
      { taskId: null, text: notCaught, kind: "notice" },
      { taskId: null, text: notCaught, kind: "notice" },
    ]);
  });

  it("lets nothing replace restarting", () => {
    const h = createHarness();
    h.state.showNotice("restarting");
    const before = counts(h);
    h.state.showNotice("wordsNotCaught");
    h.state.showNotice("restarting");
    h.state.setVoiceAvailable(false);
    expect(h.last().notice).toBe(restarting);
    expect(counts(h).slice(1)).toEqual(before.slice(1));
  });

  it("shows the voice line unsaid while voice is unavailable", () => {
    const h = createHarness();
    h.state.setVoiceAvailable(false);
    expect(h.last()).toMatchObject({
      notice: voiceLine,
      voiceAvailable: false,
    });
    expect(h.said).toEqual([]);
    h.state.setVoiceAvailable(true);
    expect(h.last()).toMatchObject({ notice: null, voiceAvailable: true });
  });
});

describe("notices and ask", () => {
  it("clears words not caught on ask", () => {
    const h = createHarness();
    h.state.showNotice("wordsNotCaught");
    h.state.ask("hi", null, null);
    expect(h.last().notice).toBeNull();
  });

  it("brings the voice line back when ask clears words not caught", () => {
    const h = createHarness();
    h.state.setVoiceAvailable(false);
    h.state.showNotice("wordsNotCaught");
    expect(h.last().notice).toBe(notCaught);
    h.state.ask("hi", null, null);
    expect(h.last().notice).toBe(voiceLine);
  });

  it("keeps another notice when voice comes back", () => {
    const h = createHarness();
    h.state.setVoiceAvailable(false);
    h.state.showNotice("wordsNotCaught");
    h.state.setVoiceAvailable(true);
    expect(h.last()).toMatchObject({ notice: notCaught, voiceAvailable: true });
  });
});

describe("voice and mute changes", () => {
  it("drops a voice availability that does not change", () => {
    const h = createHarness();
    h.state.setVoiceAvailable(true);
    expect(counts(h)).toEqual([0, 0, 0]);
  });

  it("publishes a mute change", () => {
    const h = createHarness();
    h.state.setMuted(true);
    expect(h.last().muted).toBe(true);
  });
});
