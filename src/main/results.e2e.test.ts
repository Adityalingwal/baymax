import { describe, expect, it } from "vitest";
import type { Findings } from "../shared/cards";
import type { FailureKind, Incomplete } from "../shared/engine";
import { admitAs, admitTask, runToDone, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";
import { findings } from "./tasks/harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function spokenAll(w: Wired): Promise<string[]> {
  await flush();
  await w.playAll();
  return w.spoken();
}

const found: Findings = { cardText: "Partial.", sources: [], openPoints: [] };

// The topic the front call gave the task; its first part names the task in the lines.
const topic = "how Hermes works, from its docs";

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
];

type IncompleteRow = {
  name: string;
  incomplete: Incomplete;
  line: string | null;
  missing: string | null;
  spoken: string;
};

const errorCauseRows: IncompleteRow[] = failureRows.map((row) => ({
  name: `error caused by ${row.kind}`,
  incomplete: { kind: "error", cause: row.kind, findings: found },
  line: row.line,
  missing: null,
  spoken: row.line,
}));

const answered = { ...found, openPoints: ["the price in India", "the weight"] };

const incompleteRows: IncompleteRow[] = [
  {
    name: "limitHit with an answer and open points",
    incomplete: {
      kind: "limitHit",
      findings: answered,
      spokenLine: "Hermes runs a loop.",
    },
    line: null,
    missing: "Not found: the price in India; the weight",
    spoken: "Hermes runs a loop.",
  },
  {
    name: "limitHit with an answer and nothing open",
    incomplete: {
      kind: "limitHit",
      findings: { ...found, openPoints: [] },
      spokenLine: "Hermes runs a loop.",
    },
    line: null,
    missing: null,
    spoken: "Hermes runs a loop.",
  },
  {
    name: "limitHit with an answer whose spoken line is empty",
    incomplete: { kind: "limitHit", findings: answered, spokenLine: "" },
    line: null,
    missing: "Not found: the price in India; the weight",
    spoken: "Here's what I found on how Hermes works.",
  },
  {
    name: "limitHit with pages only",
    incomplete: { kind: "limitHit", findings: found },
    line: "I couldn't finish an answer on how Hermes works; here are the pages I read.",
    missing: null,
    spoken:
      "I couldn't finish an answer on how Hermes works; here are the pages I read.",
  },
  {
    name: "limitHit without findings",
    incomplete: { kind: "limitHit", findings: null },
    line: "I couldn't find an answer on how Hermes works.",
    missing: null,
    spoken: "I couldn't find an answer on how Hermes works.",
  },
  {
    name: "sourcesThin with findings",
    incomplete: { kind: "sourcesThin", findings: found },
    line: "How Hermes works found little on the web; here is what I found.",
    missing: null,
    spoken: "How Hermes works found little on the web; here is what I found.",
  },
  {
    name: "sourcesThin without findings",
    incomplete: { kind: "sourcesThin", findings: null },
    line: "How Hermes works found little on the web before it found anything.",
    missing: null,
    spoken:
      "How Hermes works found little on the web before it found anything.",
  },
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
    step: { tool: "search", query: "hermes docs" },
    text: "searching: hermes docs",
  },
  {
    step: { tool: "read", url: "https://github.com/x/y" },
    text: "reading github.com",
  },
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

describe("an incomplete task through the wiring", () => {
  it.each(incompleteRows)(
    "$name shows and says its line",
    async ({ incomplete, line, missing, spoken }) => {
      const w = wire();
      await admitAs(w, topic);
      w.port.emit({
        type: "progress",
        taskId: "t1",
        step: { tool: "search", query: "hermes" },
        sourcesRead: 2,
      });
      w.port.emit({ type: "incomplete", taskId: "t1", incomplete });
      expect(w.card("t1")).toMatchObject({
        state: "incomplete",
        answer: incomplete.findings,
        line,
        missing,
        step: null,
        sourcesRead: 2,
      });
      // The worker's own text (its question or its answer) is said as given; fixed lines are said as written.
      expect((await spokenAll(w)).at(-1)).toBe(spoken);
      expect(w.talkerCalls).toHaveLength(1);
    },
  );
});

describe("a running task's step", () => {
  it.each(stepRows)("shows $text", async ({ step, text }) => {
    const w = wire();
    await admitAs(w, "hermes");
    w.port.emit({ type: "progress", taskId: "t1", step, sourcesRead: 1 });
    expect(w.card("t1")).toMatchObject({ step: text, sourcesRead: 1 });
  });
});

const tenMinutes = 10 * 60 * 1000;

const endedRows = [
  { name: "done", end: runToDone },
  {
    name: "incomplete",
    end: async (w: Wired) => {
      await admitTask(w);
      w.port.emit({
        type: "incomplete",
        taskId: "t1",
        incomplete: { kind: "limitHit", findings: findings("Part.") },
      });
    },
  },
];

describe("an ended card stays until the user acts", () => {
  it.each(endedRows)(
    "keeps a $name card open after 10 minutes",
    async ({ name, end }) => {
      const w = wire();
      await end(w);
      w.advance(tenMinutes);
      expect(w.card("t1")).toMatchObject({ state: name });
    },
  );
});
