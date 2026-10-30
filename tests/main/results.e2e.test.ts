import { describe, expect, it } from "vitest";
import type { Findings } from "../../src/shared/cards";
import type { FailureCause } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import {
  admitAs,
  admitTask,
  runToDone,
  streamFront,
  wire,
} from "./wiring.harness";
import type { Wired } from "./wiring.harness";
import { findings, newTask } from "./tasks/harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function spokenAll(w: Wired): Promise<string[]> {
  await flush();
  await w.playAll();
  return w.spoken();
}

const found: Findings = { cardText: "- Page one", sources: [] };

const limitLine = "I ran out of time on that one before I had an answer.";
const errorLine = "I hit an error on that question. Try again.";

type FailedRow = {
  name: string;
  cause: FailureCause;
  reason?: string;
  answer: Findings | null;
  line: string;
};

const failedRows: FailedRow[] = [
  {
    name: "nothing found, its reason said as written",
    cause: "nothingFound",
    reason: "No page mentions a Hermes 9.",
    answer: null,
    line: "No page mentions a Hermes 9.",
  },
  {
    name: "a limit with pages",
    cause: "limitHit",
    answer: found,
    line: limitLine,
  },
  {
    name: "a limit with nothing",
    cause: "limitHit",
    answer: null,
    line: limitLine,
  },
  {
    name: "an error with pages",
    cause: "error",
    answer: found,
    line: errorLine,
  },
  {
    name: "an error with nothing",
    cause: "error",
    answer: null,
    line: errorLine,
  },
  {
    name: "models unreachable",
    cause: "modelsUnreachable",
    answer: found,
    line: "I can't reach my models right now. Try again in a few minutes.",
  },
  {
    name: "search down",
    cause: "searchDown",
    answer: found,
    line: "Search isn't working right now. Try again in a few minutes.",
  },
  {
    name: "a rejected model key",
    cause: "keyRejected",
    answer: found,
    line: "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
  },
  {
    name: "no credit",
    cause: "noCredit",
    answer: null,
    line: "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
  },
  {
    name: "a rejected search key",
    cause: "searchKeyRejected",
    answer: null,
    line: "Baymax's search service rejected its key. Please tell the person who set up Baymax.",
  },
  {
    name: "a reached search quota",
    cause: "searchQuota",
    answer: found,
    line: "Baymax's search service has reached its quota. Please tell the person who set up Baymax.",
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

describe("a failed task through the wiring", () => {
  it.each(failedRows)(
    "$name shows and says its line",
    async ({ cause, reason, answer, line }) => {
      const w = wire();
      await admitAs(w, "hermes");
      w.port.emit({
        type: "progress",
        taskId: "t1",
        step: { tool: "search", query: "hermes" },
        sourcesRead: 2,
      });
      w.port.emit({
        type: "failed",
        taskId: "t1",
        cause,
        reason: reason ?? null,
        findings: answer,
      });
      expect(w.card("t1")).toMatchObject({
        state: "failed",
        answer,
        line,
        spokenLine: null,
        step: null,
        sourcesRead: 2,
      });
      expect((await spokenAll(w)).at(-1)).toBe(line);
      expect(w.talkerCalls).toHaveLength(1);
    },
  );
});

describe("a result with an empty report", () => {
  it("says and shows its line, with no report to show", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    const empty = { cardText: "", sources: [] };
    w.port.emit({
      type: "result",
      taskId: "t1",
      spokenLine: "It is 31 degrees in Delhi.",
      findings: empty,
    });
    expect(w.card("t1")).toMatchObject({
      state: "done",
      answer: empty,
      line: null,
      spokenLine: "It is 31 degrees in Delhi.",
    });
    expect((await spokenAll(w)).at(-1)).toBe("It is 31 degrees in Delhi.");
  });
});

describe("a card's title", () => {
  it("is the topic once the front call gave one, and the words stay as asked", async () => {
    const w = wire();
    w.send(ipcChannels.submitQuestion, { text: "tell me hermes" });
    expect(w.card("t1")).toMatchObject({ title: null });
    await streamFront(w, newTask("how Hermes works"), "Checking.");
    expect(w.card("t1")).toMatchObject({
      title: "how Hermes works",
      words: "tell me hermes",
    });
  });
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
    name: "failed",
    end: async (w: Wired) => {
      await admitTask(w);
      w.port.emit({
        type: "failed",
        taskId: "t1",
        cause: "limitHit",
        reason: null,
        findings: findings("Part."),
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
