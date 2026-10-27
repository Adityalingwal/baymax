import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import { counts, createHarness } from "./harness";
import { fixedLines } from "./lines";

const notCaught = fixedLines.wordsNotCaught;
const micBlocked = fixedLines.micBlocked;
const noMicrophone = fixedLines.noMicrophone;
const voiceLine = fixedLines.voiceUnavailable;
const restarting = fixedLines.restarting;

type Step = (h: Harness) => void;

const steps = {
  none: () => undefined,
  wordsNotCaught: (h) => h.state.showNotice("wordsNotCaught"),
  micBlocked: (h) => h.state.showNotice("micBlocked"),
  noMicrophone: (h) => h.state.showNotice("noMicrophone"),
  restarting: (h) => h.state.showNotice("restarting"),
  voiceDown: (h) => h.state.setVoiceAvailable(false),
  voiceUp: (h) => h.state.setVoiceAvailable(true),
  restartingVoiceDown: (h) => {
    h.state.setVoiceAvailable(false);
    h.state.showNotice("restarting");
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

describe("notice priority", () => {
  it.each(priorityRows)(
    "$current then $incoming shows $shown",
    ({ current, incoming, shown, said }) => {
      const h = createHarness();
      steps[current](h);
      const before = h.said.length;
      steps[incoming](h);
      expect(h.state.displayState().notice).toBe(shown);
      const expected =
        said && shown !== null
          ? [{ taskId: null, text: shown, kind: "notice" }]
          : [];
      expect(h.said.slice(before)).toEqual(expected);
    },
  );

  it("lets nothing replace restarting and publishes only the voice change", () => {
    const h = createHarness();
    h.state.showNotice("restarting");
    const before = counts(h);
    h.state.showNotice("wordsNotCaught");
    h.state.showNotice("restarting");
    h.state.setVoiceAvailable(false);
    expect(h.last()).toMatchObject({
      notice: restarting,
      voiceAvailable: false,
    });
    expect(counts(h)).toEqual([before[0] + 1, before[1], before[2]]);
  });

  it("shows and says the voice line while voice is unavailable", () => {
    const h = createHarness();
    h.state.setVoiceAvailable(false);
    expect(h.last()).toMatchObject({
      notice: voiceLine,
      voiceAvailable: false,
    });
    expect(h.said).toEqual([{ taskId: null, text: voiceLine, kind: "notice" }]);
    h.state.setVoiceAvailable(true);
    expect(h.last()).toMatchObject({ notice: null, voiceAvailable: true });
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
    const h = createHarness();
    steps[current](h);
    h.state.ask("hi", null, null);
    expect(h.last().notice).toBe(shown);
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
