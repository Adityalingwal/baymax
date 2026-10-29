import { describe, expect, it } from "vitest";
import type { Incomplete } from "../../shared/engine";
import type { SaidKind } from "./state";
import { askNew, createHarness, findings } from "./harness";

type Row = {
  name: string;
  incomplete: Incomplete;
  line: string | null;
  missing: string | null;
  said: string;
  kind: SaidKind;
};

const part = findings("Part.");

const rows: Row[] = [
  {
    name: "limitHit with an answer",
    incomplete: {
      kind: "limitHit",
      findings: { ...part, openPoints: ["the price"] },
      spokenLine: "Hermes runs a loop.",
    },
    line: null,
    missing: "Not found: the price",
    said: "Hermes runs a loop.",
    kind: "incomplete",
  },
  {
    name: "limitHit with pages only",
    incomplete: { kind: "limitHit", findings: part },
    line: "I couldn't finish an answer on hermes; here are the pages I read.",
    missing: null,
    said: "I couldn't finish an answer on hermes; here are the pages I read.",
    kind: "incomplete",
  },
  {
    name: "sourcesThin",
    incomplete: { kind: "sourcesThin", findings: null },
    line: "Hermes found little on the web before it found anything.",
    missing: null,
    said: "Hermes found little on the web before it found anything.",
    kind: "incomplete",
  },
  {
    name: "error caused by error",
    incomplete: { kind: "error", cause: "error", findings: part },
    line: "Hermes hit an error; here is what I found.",
    missing: null,
    said: "Hermes hit an error; here is what I found.",
    kind: "incomplete",
  },
  {
    name: "error caused by noCredit",
    incomplete: { kind: "error", cause: "noCredit", findings: null },
    line: "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
    missing: null,
    said: "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
    kind: "incomplete",
  },
  {
    name: "unchecked",
    incomplete: {
      kind: "unchecked",
      uncheckedPart: "The dates.",
      findings: part,
    },
    line: "Hermes is finished, but I couldn't check all of it; the unchecked part is marked.",
    missing: "The dates.",
    said: "Hermes is finished, but I couldn't check all of it; the unchecked part is marked.",
    kind: "incomplete",
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
    said: "Which version?",
    kind: "incomplete",
  },
];

describe("an incomplete task", () => {
  it.each(rows)(
    "$name shows and says its line",
    ({ incomplete, line, missing, said, kind }) => {
      const h = createHarness();
      askNew(h, "hermes, from its docs");
      h.state.receive({
        type: "progress",
        taskId: "t1",
        step: { tool: "search", query: "hermes" },
        sourcesRead: 2,
      });
      h.state.receive({ type: "incomplete", taskId: "t1", incomplete });
      expect(h.card("t1")).toMatchObject({
        state: "incomplete",
        answer: incomplete.findings,
        line,
        missing,
        step: null,
        sourcesRead: 2,
      });
      // The worker's own text (its question or its answer) is said as given; fixed lines are said as written.
      expect(h.said.at(-1)).toEqual({ taskId: "t1", text: said, kind });
      expect(h.talked).toHaveLength(1);
    },
  );
});
