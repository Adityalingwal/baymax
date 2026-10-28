import { describe, expect, it } from "vitest";
import type { Synthesis } from "../providers/deepgram";
import type { UtteranceId } from "../shared/cards";
import { ipcChannels } from "../shared/ipc";
import { fixedLines } from "./tasks/lines";
import { fakeSender, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const audio: Synthesis = {
  kind: "audio",
  audio: new Uint8Array([1]).buffer,
  mimeType: "audio/mpeg",
};

function heldAndReleased(w: Wired): UtteranceId {
  w.wiring.voice.holdChanged("listening", null);
  w.wiring.voice.holdChanged("idle", "accept");
  const start = w.recordings.find((command) => command.type === "start");
  if (start === undefined) throw new Error("no recording start sent");
  return start.utteranceId;
}

const frames = (utteranceId: UtteranceId, pcm: unknown) => ({
  type: "frames",
  utteranceId,
  pcm,
});

describe("the mic audio channel", () => {
  it.each([
    ["an ArrayBuffer", new Uint8Array([7, 8, 9]).buffer],
    [
      "a view of part of a buffer",
      new Uint8Array([6, 7, 8, 9, 5]).subarray(1, 4),
    ],
  ])("brings frames in %s to transcription", (_name, pcm) => {
    const w = wire();
    const utteranceId = heldAndReleased(w);
    w.send(ipcChannels.micAudio, frames(utteranceId, pcm));
    w.send(ipcChannels.micAudio, { type: "end", utteranceId });
    expect(w.transcriptions.map((call) => call.input)).toEqual([
      "audio/wav 7,8,9",
    ]);
    expect(w.failures).toEqual([]);
  });

  it("drops audio from another sender and malformed audio", () => {
    const w = wire();
    const utteranceId = heldAndReleased(w);
    const audio = frames(utteranceId, new ArrayBuffer(3));
    w.send(ipcChannels.micAudio, audio, fakeSender().sender);
    w.send(ipcChannels.micAudio, { ...audio, pcm: 3 });
    w.send(ipcChannels.micAudio, { type: "end", utteranceId });
    expect(w.transcriptions).toEqual([]);
    expect(w.logs.slice(-2)).toEqual([
      `${ipcChannels.micAudio} dropped: not from the Baymax window`,
      `${ipcChannels.micAudio} dropped: malformed payload`,
    ]);
  });

  it("asks main's state with the heard words", async () => {
    const w = wire();
    const utteranceId = heldAndReleased(w);
    w.send(ipcChannels.micAudio, frames(utteranceId, new ArrayBuffer(3)));
    w.send(ipcChannels.micAudio, { type: "end", utteranceId });
    w.transcriptions[0].resolve({ kind: "words", words: "how does it work" });
    await flush();
    expect(w.port.sent).toMatchObject([
      { type: "question", utteranceId, words: "how does it work" },
    ]);
  });
});

describe("main's lines and voice", () => {
  it("speaks main's lines one at a time, the next after playback ends", async () => {
    const w = wire();
    w.wiring.state.showNotice("wordsNotCaught");
    w.wiring.state.showNotice("micBlocked");
    expect(w.syntheses.map((call) => call.input)).toEqual([
      fixedLines.wordsNotCaught,
    ]);
    w.syntheses[0].resolve(audio);
    await flush();
    const lineId = w.speeches[0].lineId;
    w.send(ipcChannels.playbackFinished, { lineId, outcome: "ended" });
    expect(w.syntheses.map((call) => call.input)).toEqual([
      fixedLines.wordsNotCaught,
      fixedLines.micBlocked,
    ]);
  });

  it("silences a cancelled task's line", async () => {
    const w = wire();
    w.send(ipcChannels.submitQuestion, { text: "how does hermes work" });
    await flush();
    w.port.emit({ type: "failure", taskId: "t1", kind: "error" });
    expect(w.syntheses).toHaveLength(1);
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    w.syntheses[0].resolve(audio);
    await flush();
    expect(w.speeches).toEqual([]);
  });

  it("mutes main's state and speech together", () => {
    const w = wire();
    w.send(ipcChannels.setMuted, { muted: true });
    w.wiring.state.showNotice("wordsNotCaught");
    expect(w.published.at(-1)?.muted).toBe(true);
    expect(w.syntheses).toEqual([]);
  });

  it("shows and says voice down from the start without a Deepgram key", () => {
    const w = wire({ deepgramKeyPresent: false });
    expect(w.published).toHaveLength(1);
    expect(w.published[0]).toMatchObject({
      voiceAvailable: false,
      notice: fixedLines.voiceUnavailable,
    });
    expect(w.syntheses.map((call) => call.input)).toEqual([
      fixedLines.voiceUnavailable,
    ]);
  });
});

describe("closing the wiring", () => {
  it("ends an open recording and ignores later holds", () => {
    const w = wire();
    w.wiring.voice.holdChanged("listening", null);
    w.wiring.close();
    w.wiring.voice.holdChanged("idle", "accept");
    w.wiring.voice.holdChanged("listening", null);
    expect(w.recordings.map((command) => command.type)).toEqual([
      "start",
      "stop",
    ]);
  });
});
