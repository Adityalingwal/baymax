import { describe, expect, it } from "vitest";
import type { Findings } from "../../shared/cards";
import type { FailureKind, Incomplete } from "../../shared/engine";
import {
  failureLine,
  fixedLines,
  incompleteLines,
  stepText,
  taskShortForm,
} from "./lines";

const found: Findings = { cardText: "Partial.", sources: [], openPoints: [] };

const fixedRows: { name: keyof typeof fixedLines; line: string }[] = [
  { name: "letMeCheck", line: "Let me check." },
  { name: "queued", line: "Okay, I'll look at that after the current one." },
  {
    name: "queueFull",
    line: "I already have three waiting. Cancel one or ask again later.",
  },
  { name: "outsideResearch", line: "I can't do that yet in this version." },
  { name: "wordsNotCaught", line: "I didn't catch that, say it again." },
  {
    name: "micBlocked",
    line: "I can't use the microphone. Allow Baymax in System Settings, Privacy and Security, Microphone, or type your question.",
  },
  {
    name: "noMicrophone",
    line: "I can't find a microphone. Connect one, or type your question.",
  },
  {
    name: "voiceUnavailable",
    line: "Voice isn't working right now. You can type your question instead.",
  },
  { name: "restarting", line: "Baymax hit a problem and is restarting." },
];

const failureRows: { kind: FailureKind; line: string }[] = [
  {
    kind: "modelsUnreachable",
    line: "I can't reach my models right now. Try again in a few minutes.",
  },
  {
    kind: "searchDown",
    line: "Search isn't working right now. Try again in a few minutes.",
  },
  {
    kind: "keyRejected",
    line: "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
  },
  {
    kind: "noCredit",
    line: "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
  },
  { kind: "error", line: "I hit an error on that question. Try again." },
];

const shortFormRows: { sayBack: string | null; short: string }[] = [
  {
    sayBack: "how Hermes works inside, from its docs",
    short: "How Hermes works inside",
  },
  { sayBack: "  rust async runtimes  ", short: "Rust async runtimes" },
  { sayBack: null, short: "This task" },
  { sayBack: "", short: "This task" },
];

const sayBack = "how Hermes works, from its docs";

type IncompleteRow = {
  name: string;
  incomplete: Incomplete;
  line: string | null;
  missing: string | null;
  spoken: string;
};

const errorCauseRows: IncompleteRow[] = failureRows
  .filter((row) => row.kind !== "error")
  .map((row) => ({
    name: `error caused by ${row.kind}`,
    incomplete: { kind: "error", cause: row.kind, findings: found },
    line: row.line,
    missing: null,
    spoken: row.line,
  }));

const incompleteRows: IncompleteRow[] = [
  ...(
    [
      ["limitHit", "reached its limit"],
      ["sourcesThin", "found little on the web"],
    ] as const
  ).flatMap(([kind, words]) => [
    {
      name: `${kind} with findings`,
      incomplete: { kind, findings: found },
      line: `How Hermes works ${words}; here is what I found.`,
      missing: null,
      spoken: `How Hermes works ${words}; here is what I found.`,
    },
    {
      name: `${kind} without findings`,
      incomplete: { kind, findings: null },
      line: `How Hermes works ${words} before it found anything.`,
      missing: null,
      spoken: `How Hermes works ${words} before it found anything.`,
    },
  ]),
  {
    name: "error with findings",
    incomplete: { kind: "error", cause: "error", findings: found },
    line: "How Hermes works hit an error; here is what I found.",
    missing: null,
    spoken: "How Hermes works hit an error; here is what I found.",
  },
  {
    name: "error without findings",
    incomplete: { kind: "error", cause: "error", findings: null },
    line: "How Hermes works hit an error before it found anything.",
    missing: null,
    spoken: "How Hermes works hit an error before it found anything.",
  },
  ...errorCauseRows,
  {
    name: "unchecked",
    incomplete: {
      kind: "unchecked",
      uncheckedPart: "The dates.",
      findings: found,
    },
    line: "How Hermes works is finished, but I couldn't check all of it; the unchecked part is marked.",
    missing: "The dates.",
    spoken:
      "How Hermes works is finished, but I couldn't check all of it; the unchecked part is marked.",
  },
  {
    name: "needsUser",
    incomplete: {
      kind: "needsUser",
      nextQuestion: "Which version?",
      findings: null,
    },
    line: null,
    missing: "Which version?",
    spoken: "Which version?",
  },
];

const stepRows = [
  {
    step: { tool: "search", query: "how Hermes works" },
    text: "searching: how Hermes works",
  },
  {
    step: { tool: "read", url: "https://github.com/a/b?c=1" },
    text: "reading github.com",
  },
  { step: { tool: "read", url: "not a url" }, text: "reading not a url" },
] as const;

describe("fixed lines", () => {
  it.each(fixedRows)("$name", ({ name, line }) => {
    expect(fixedLines[name]).toBe(line);
  });

  it.each(failureRows)("failure $kind", ({ kind, line }) => {
    expect(failureLine(kind)).toBe(line);
  });

  it.each(shortFormRows)("short form of $sayBack", ({ sayBack, short }) => {
    expect(taskShortForm(sayBack)).toBe(short);
  });

  it.each(incompleteRows)(
    "incomplete $name",
    ({ incomplete, line, missing, spoken }) => {
      expect(incompleteLines(incomplete, sayBack)).toEqual({
        line,
        missing,
        spoken,
      });
    },
  );

  it.each(stepRows)("step $text", ({ step, text }) => {
    expect(stepText(step)).toBe(text);
  });
});
