import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import {
  askFollowUp,
  askNew,
  createHarness,
  findings,
  finish,
} from "./harness";

const label = "Built on the partial findings of an earlier question.";

type ParentEnd = {
  name: string;
  end: (h: Harness) => void;
  line: string | null; // the partial-parent line; null for a done parent, which shows no line
  labelled: boolean;
};

const incomplete = (h: Harness, found: boolean) =>
  h.state.receive({
    type: "incomplete",
    taskId: "t1",
    incomplete: {
      kind: "limitHit",
      findings: found ? findings("Part.") : null,
    },
  });

const cancelled = (h: Harness, found: boolean) => {
  h.state.cancelTask("t1");
  h.state.receive({
    type: "cancelled",
    taskId: "t1",
    findings: found ? findings("Cut.") : null,
  });
};

const parentEnds: ParentEnd[] = [
  {
    name: "incomplete with findings",
    end: (h) => incomplete(h, true),
    line: "Hermes ended without a full answer, so I'll build on what it found.",
    labelled: true,
  },
  {
    name: "incomplete without findings",
    end: (h) => incomplete(h, false),
    line: "Hermes ended before it found anything.",
    labelled: false,
  },
  {
    name: "cancelled with findings",
    end: (h) => cancelled(h, true),
    line: "Hermes was cancelled, so I'll build on what it found.",
    labelled: true,
  },
  {
    name: "cancelled without findings",
    end: (h) => cancelled(h, false),
    line: "Hermes was cancelled before it found anything.",
    labelled: false,
  },
  { name: "done", end: (h) => finish(h, "t1"), line: null, labelled: false },
];

const afterEnded = "asked after the parent ended";
const queued = "queued while the parent ran";

const rows = parentEnds.flatMap((parentEnd) =>
  [afterEnded, queued].map((start) => ({ ...parentEnd, start })),
);

// The partial-parent line and the queued line show on the card only; main's state says neither.
function saidFor(h: Harness, taskId: string): string[] {
  return h.said
    .filter((line) => line.taskId === taskId)
    .map((line) => line.text);
}

describe("a follow-up of a parent that did not end done", () => {
  it.each(rows)(
    "parent $name, $start: card line, said lines and done label",
    ({ end, line, labelled, start }) => {
      const h = createHarness();
      askNew(h, "hermes");
      let child: string;
      if (start === afterEnded) {
        end(h);
        child = askFollowUp(h, "t1", "more");
      } else {
        child = askFollowUp(h, "t1", "more");
        expect(h.card(child)?.state).toBe("queued");
        end(h);
      }
      expect(h.card(child)).toMatchObject({
        state: "running",
        line,
      });
      expect(saidFor(h, child)).toEqual([]);
      finish(h, child);
      expect(h.card(child)).toMatchObject({
        state: "done",
        line: labelled ? label : null,
      });
    },
  );

  it("names the parent 'The earlier question' when it was cancelled before it had a topic", () => {
    const h = createHarness();
    h.state.ask("first", null, null);
    cancelled(h, false);
    const child = askFollowUp(h, "t1", "more");
    const line = "The earlier question was cancelled before it found anything.";
    expect(h.card(child)).toMatchObject({ state: "running", line });
    expect(saidFor(h, child)).toEqual([]);
  });
});
