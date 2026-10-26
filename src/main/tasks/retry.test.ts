import { describe, expect, it } from "vitest";
import type { FailureKind } from "../../shared/engine";
import type { Harness } from "./harness";
import { askClarify, counts, createHarness, intake } from "./harness";

type Row = {
  name: string;
  setup: (h: Harness) => void;
  fail: (h: Harness) => void;
  line: string;
};

function failWith(kind: FailureKind): (h: Harness) => void {
  return (h) => h.state.receive({ type: "failure", taskId: "t1", kind });
}

const answerInFlight = (h: Harness): void => {
  askClarify(h, "q1");
  h.state.answerQuestion({
    taskId: "t1",
    questionId: "q1",
    reply: { kind: "text", text: "the docs" },
  });
};

const rows: Row[] = [
  {
    name: "an intake failure",
    setup: (h) => h.state.ask("hi", null, null),
    fail: failWith("modelsUnreachable"),
    line: "I can't reach my models right now. Try again in a few minutes.",
  },
  {
    name: "a clarifyingAnswer failure",
    setup: answerInFlight,
    fail: failWith("searchDown"),
    line: "Search isn't working right now. Try again in a few minutes.",
  },
  {
    name: "an answer route in reply to a clarifyingAnswer",
    setup: answerInFlight,
    fail: (h) =>
      h.state.receive(
        intake("t1", {
          route: "answer",
          waitingTaskId: "t1",
          questionId: "q1",
          reply: { kind: "choice", index: 0 },
        }),
      ),
    line: "I hit an error on that question. Try again.",
  },
];

describe("intake failures and retry", () => {
  it.each(rows)(
    "$name shows the kind's line with retry",
    ({ setup, fail, line }) => {
      const h = createHarness();
      setup(h);
      const state = h.card("t1")?.state;
      fail(h);
      expect(h.card("t1")).toMatchObject({ state, line, canRetry: true });
      expect(h.said.at(-1)).toEqual({
        taskId: "t1",
        text: line,
        kind: "failure",
      });
    },
  );

  it.each(rows)(
    "retry after $name re-sends the identical command once",
    ({ setup, fail }) => {
      const h = createHarness();
      setup(h);
      const command = h.sent.at(-1);
      fail(h);
      const [published, sent] = counts(h);
      h.state.retryTask("t1");
      expect(h.sent.slice(sent)).toEqual([command]);
      expect(h.published.length).toBe(published + 1);
      expect(h.card("t1")).toMatchObject({ line: null, canRetry: false });
      const before = counts(h);
      h.state.retryTask("t1");
      expect(counts(h)).toEqual(before);
    },
  );
});
