import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import {
  askClarify,
  chat,
  counts,
  createHarness,
  newTask,
  questionIdOf,
} from "./harness";

type Row = {
  name: string;
  setup: (h: Harness) => string; // returns the task id whose call fails
  fail: (h: Harness) => void;
  line: string;
  state: string;
};

const answerInFlight = (h: Harness): string => {
  askClarify(h);
  h.state.answerQuestion({
    taskId: "t1",
    questionId: questionIdOf("t1"),
    reply: { kind: "text", text: "the docs" },
  });
  return "t1";
};

const rows: Row[] = [
  {
    name: "an ordinary request's failed call",
    setup: (h) => {
      h.state.ask("hi", null, null);
      return "t1";
    },
    fail: (h) => h.replyFailed("t1", "modelsUnreachable"),
    line: "Sorry, I missed that. Ask again.",
    state: "thinking",
  },
  {
    name: "a question-card answer's failed call",
    setup: answerInFlight,
    fail: (h) => h.replyFailed("t1", "error", "Checking the docs."),
    line: "That didn't go through. Ask again.",
    state: "clarifying",
  },
  {
    name: "a decision that fails its check",
    setup: (h) => {
      h.state.ask("hi", null, null);
      return "t1";
    },
    fail: (h) => h.reply("t1", { route: "newTask" }),
    line: "That didn't go through. Ask again.",
    state: "thinking",
  },
];

describe("front call failures and retry", () => {
  it.each(rows)("$name shows the cause's line with retry", (row) => {
    const h = createHarness();
    row.setup(h);
    row.fail(h);
    expect(h.card("t1")).toMatchObject({
      state: row.state,
      line: row.line,
      canRetry: true,
    });
    expect(h.said.at(-1)).toEqual({
      taskId: "t1",
      text: row.line,
      kind: "failure",
    });
    expect(h.sent).toEqual([]);
  });

  it.each(rows)(
    "retry after $name re-runs the same request as a fresh attempt, once",
    (row) => {
      const h = createHarness();
      row.setup(h);
      const first = h.talked.at(-1);
      row.fail(h);
      const [published] = counts(h);
      h.state.retryTask("t1");
      const attempts = Number(first?.attemptId.split("#")[1]);
      expect(h.talked.at(-1)).toEqual({
        ...first,
        attemptId: `t1#${String(attempts + 1)}`,
      });
      expect(h.published.length).toBe(published + 1);
      expect(h.card("t1")).toMatchObject({ line: null, canRetry: false });
      const before = counts(h);
      h.state.retryTask("t1");
      expect(counts(h)).toEqual(before);
    },
  );
});

describe("the result of a retried front call", () => {
  it("takes only the retry's own result: the failed attempt's late result is dropped", () => {
    const h = createHarness();
    h.state.ask("what is 2 + 2?", null, null);
    h.replyFailed("t1", "error");
    h.state.retryTask("t1");
    h.state.talkerReplied("t1", "t1#1", {
      kind: "said",
      text: "late",
      decision: chat(),
    });
    expect(h.card("t1")).toMatchObject({ state: "thinking", reply: null });
    h.reply("t1", chat(), "It's four.");
    expect(h.card("t1")).toMatchObject({
      state: "done",
      reply: "It's four.",
      line: null,
      canRetry: false,
    });
  });

  it("succeeds after a failed question-card answer and starts the worker", () => {
    const h = createHarness();
    answerInFlight(h);
    h.replyFailed("t1", "error");
    h.state.retryTask("t1");
    h.reply("t1", newTask("the docs"), "Checking.");
    expect(h.card("t1")).toMatchObject({ state: "running", canRetry: false });
    expect(h.sent.at(-1)).toMatchObject({ type: "runTask", taskId: "t1" });
  });

  it("drops a retry after the card was cancelled, and a retry of a call that is still in flight", () => {
    const h = createHarness();
    h.state.ask("hi", null, null);
    const before = counts(h);
    h.state.retryTask("t1");
    expect(counts(h)).toEqual(before);
    h.replyFailed("t1", "error");
    h.state.cancelTask("t1");
    const ended = counts(h);
    h.state.retryTask("t1");
    expect(counts(h)).toEqual(ended);
  });
});
