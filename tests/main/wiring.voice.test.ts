import { describe, expect, it } from "vitest";
import type { Synthesis } from "../../src/providers/deepgram";
import type { UtteranceId } from "../../src/shared/cards";
import { ipcChannels } from "../../src/shared/ipc";
import { admitAs, fakeSender, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

// The fixed lines as written, so a changed cause or fix in the app fails here.
const fixedLines = {
  wordsNotCaught: "I didn't catch that, say it again.",
  micBlocked:
    "I can't use the microphone. Allow Baymax in System Settings, Privacy and Security, Microphone, or type your question.",
  noMicrophone:
    "I can't find a microphone. Connect one, or type your question.",
  voiceUnavailable:
    "Voice isn't working right now. You can type your question instead.",
  restarting: "Baymax hit a problem and is restarting.",
};

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
    expect(w.port.sent).toEqual([]);
    expect(w.talkerCalls).toHaveLength(1);
    expect(String(w.talkerCalls[0].request.messages.at(-1)?.content)).toContain(
      "<words>\nhow does it work\n</words>",
    );
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
    await admitAs(w, "hermes");
    expect(w.syntheses).toHaveLength(1);
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    w.syntheses[0].resolve(audio);
    await flush();
    expect(w.speeches).toEqual([]);
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

describe("mute", () => {
  it("mutes main's state and speech together", () => {
    const w = wire();
    w.send(ipcChannels.setMuted, { muted: true });
    w.wiring.state.showNotice("wordsNotCaught");
    expect(w.published.at(-1)?.muted).toBe(true);
    expect(w.syntheses).toEqual([]);
    w.send(ipcChannels.setMuted, { muted: false });
    expect(w.published.at(-1)?.muted).toBe(false);
    w.wiring.voice.say({ taskId: "t1", text: "Again.", kind: "answer" });
    expect(w.syntheses.map((call) => call.input)).toEqual(["Again."]);
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

const notCaught = fixedLines.wordsNotCaught;
const micBlocked = fixedLines.micBlocked;
const noMicrophone = fixedLines.noMicrophone;
const voiceLine = fixedLines.voiceUnavailable;
const restarting = fixedLines.restarting;

type Step = (w: Wired) => void;

const steps = {
  none: () => undefined,
  wordsNotCaught: (w) => w.wiring.state.showNotice("wordsNotCaught"),
  micBlocked: (w) => w.wiring.state.showNotice("micBlocked"),
  noMicrophone: (w) => w.wiring.state.showNotice("noMicrophone"),
  restarting: (w) => w.wiring.state.showNotice("restarting"),
  voiceDown: (w) => w.wiring.state.setVoiceAvailable(false),
  voiceUp: (w) => w.wiring.state.setVoiceAvailable(true),
  restartingVoiceDown: (w) => {
    w.wiring.state.setVoiceAvailable(false);
    w.wiring.state.showNotice("restarting");
  },
} satisfies Record<string, Step>;

type StepName = keyof typeof steps;
type PriorityRow = {
  current: StepName;
  incoming: StepName;
  shown: string | null;
  said: boolean;
};

const priorityRows: PriorityRow[] = [
  { current: "none", incoming: "wordsNotCaught", shown: notCaught, said: true },
  { current: "none", incoming: "micBlocked", shown: micBlocked, said: true },
  {
    current: "none",
    incoming: "noMicrophone",
    shown: noMicrophone,
    said: true,
  },
  { current: "none", incoming: "voiceDown", shown: voiceLine, said: true },
  { current: "none", incoming: "restarting", shown: restarting, said: true },
  {
    current: "wordsNotCaught",
    incoming: "micBlocked",
    shown: micBlocked,
    said: true,
  },
  {
    current: "micBlocked",
    incoming: "noMicrophone",
    shown: noMicrophone,
    said: true,
  },
  {
    current: "noMicrophone",
    incoming: "wordsNotCaught",
    shown: notCaught,
    said: true,
  },
  {
    current: "wordsNotCaught",
    incoming: "wordsNotCaught",
    shown: notCaught,
    said: true,
  },
  {
    current: "micBlocked",
    incoming: "voiceDown",
    shown: voiceLine,
    said: true,
  },
  {
    current: "voiceDown",
    incoming: "wordsNotCaught",
    shown: voiceLine,
    said: false,
  },
  {
    current: "voiceDown",
    incoming: "micBlocked",
    shown: voiceLine,
    said: false,
  },
  {
    current: "voiceDown",
    incoming: "noMicrophone",
    shown: voiceLine,
    said: false,
  },
  { current: "voiceDown", incoming: "voiceUp", shown: null, said: false },
  {
    current: "voiceDown",
    incoming: "restarting",
    shown: restarting,
    said: true,
  },
  {
    current: "restarting",
    incoming: "wordsNotCaught",
    shown: restarting,
    said: false,
  },
  {
    current: "restarting",
    incoming: "voiceDown",
    shown: restarting,
    said: false,
  },
  {
    current: "restarting",
    incoming: "restarting",
    shown: restarting,
    said: false,
  },
  {
    current: "restartingVoiceDown",
    incoming: "voiceUp",
    shown: restarting,
    said: false,
  },
];

// Every line said so far, once the speech queue has played out.
async function saidSoFar(w: Wired): Promise<string[]> {
  await flush();
  await w.playAll();
  return w.spoken();
}

describe("notice priority", () => {
  it.each(priorityRows)(
    "$current then $incoming shows $shown",
    async ({ current, incoming, shown, said }) => {
      const w = wire();
      steps[current](w);
      const before = (await saidSoFar(w)).length;
      steps[incoming](w);
      expect(w.published.at(-1)?.notice ?? null).toBe(shown);
      const expected = said && shown !== null ? [shown] : [];
      expect((await saidSoFar(w)).slice(before)).toEqual(expected);
    },
  );

  it("lets nothing replace restarting and publishes only the voice change", async () => {
    const w = wire();
    w.wiring.state.showNotice("restarting");
    await saidSoFar(w);
    const before = [w.published.length, w.port.sent.length, w.syntheses.length];
    w.wiring.state.showNotice("wordsNotCaught");
    w.wiring.state.showNotice("restarting");
    w.wiring.state.setVoiceAvailable(false);
    expect(w.published.at(-1)).toMatchObject({
      notice: restarting,
      voiceAvailable: false,
    });
    expect([
      w.published.length,
      w.port.sent.length,
      w.syntheses.length,
    ]).toEqual([before[0] + 1, before[1], before[2]]);
  });

  it("shows and says the voice line while voice is unavailable, and drops an unchanged one", async () => {
    const w = wire();
    w.wiring.state.setVoiceAvailable(true);
    expect(w.published).toEqual([]);
    w.wiring.state.setVoiceAvailable(false);
    expect(w.published.at(-1)).toMatchObject({
      notice: voiceLine,
      voiceAvailable: false,
    });
    expect(await saidSoFar(w)).toEqual([voiceLine]);
    w.wiring.state.setVoiceAvailable(true);
    expect(w.published.at(-1)).toMatchObject({
      notice: null,
      voiceAvailable: true,
    });
  });
});

const askRows: { current: StepName; shown: string | null }[] = [
  { current: "wordsNotCaught", shown: null },
  { current: "micBlocked", shown: null },
  { current: "noMicrophone", shown: null },
  { current: "voiceDown", shown: voiceLine },
  { current: "restarting", shown: restarting },
];

describe("notices and ask", () => {
  it.each(askRows)("ask after $current shows $shown", ({ current, shown }) => {
    const w = wire();
    steps[current](w);
    w.send(ipcChannels.submitQuestion, { text: "hi" });
    expect(w.published.at(-1)?.notice ?? null).toBe(shown);
  });
});
