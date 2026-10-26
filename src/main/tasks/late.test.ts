import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import {
  askNew,
  counts,
  createHarness,
  findings,
  finish,
  intake,
  newTask,
} from "./harness";

type Row = {
  name: string;
  setup: (h: Harness) => void;
  act: (h: Harness) => void;
};

const progress = { tool: "search", query: "q" } as const;

const acceptedRows: Row[] = [
  {
    name: "ask",
    setup: () => undefined,
    act: (h) => h.state.ask("hi", null, null),
  },
  {
    name: "intake",
    setup: (h) => h.state.ask("hi", null, null),
    act: (h) => h.state.receive(intake("t1", newTask("hermes"))),
  },
  {
    name: "progress",
    setup: (h) => askNew(h, "hermes"),
    act: (h) =>
      h.state.receive({
        type: "progress",
        taskId: "t1",
        step: progress,
        sourcesRead: 1,
      }),
  },
  {
    name: "result",
    setup: (h) => askNew(h, "hermes"),
    act: (h) => finish(h, "t1"),
  },
  {
    name: "cancel",
    setup: (h) => askNew(h, "hermes"),
    act: (h) => h.state.cancelTask("t1"),
  },
  {
    name: "the 1.5 s timer",
    setup: (h) => h.state.ask("hi", null, null),
    act: (h) => h.advance(1500),
  },
  {
    name: "setMuted",
    setup: () => undefined,
    act: (h) => h.state.setMuted(true),
  },
];

function cancelling(h: Harness): void {
  askNew(h, "hermes");
  h.state.cancelTask("t1");
}

function cancelled(h: Harness): void {
  cancelling(h);
  h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
}

function oneQueued(h: Harness): void {
  askNew(h, "hermes");
  askNew(h, "rust");
}

const droppedRows: Row[] = [
  {
    name: "progress for an unknown id",
    setup: () => undefined,
    act: (h) =>
      h.state.receive({
        type: "progress",
        taskId: "t9",
        step: progress,
        sourcesRead: 1,
      }),
  },
  {
    name: "result for a done task",
    setup: (h) => {
      askNew(h, "hermes");
      finish(h, "t1");
    },
    act: (h) => finish(h, "t1", "Again."),
  },
  {
    name: "progress while cancelling",
    setup: cancelling,
    act: (h) =>
      h.state.receive({
        type: "progress",
        taskId: "t1",
        step: progress,
        sourcesRead: 2,
      }),
  },
  {
    name: "a result after cancelled",
    setup: cancelled,
    act: (h) => finish(h, "t1"),
  },
  {
    name: "a second cancelled",
    setup: cancelled,
    act: (h) =>
      h.state.receive({ type: "cancelled", taskId: "t1", findings: null }),
  },
  {
    name: "intake for a running task",
    setup: (h) => askNew(h, "hermes"),
    act: (h) => h.state.receive(intake("t1", newTask("again"))),
  },
  {
    name: "failure for a running task",
    setup: (h) => askNew(h, "hermes"),
    act: (h) =>
      h.state.receive({ type: "failure", taskId: "t1", kind: "error" }),
  },
  {
    name: "a cancelled event for a queued task",
    setup: oneQueued,
    act: (h) =>
      h.state.receive({ type: "cancelled", taskId: "t2", findings: null }),
  },
  {
    name: "the 1.5 s timer after the intake",
    setup: (h) => askNew(h, "hermes"),
    act: (h) => h.advance(1500),
  },
  {
    name: "the 3 s timer after closeCard",
    setup: (h) => {
      cancelled(h);
      h.state.closeCard("t1");
    },
    act: (h) => h.advance(3000),
  },
  {
    name: "a no-op setMuted",
    setup: () => undefined,
    act: (h) => h.state.setMuted(false),
  },
  {
    name: "retry on a cancelled card",
    setup: cancelled,
    act: (h) => h.state.retryTask("t1"),
  },
  {
    name: "empty words",
    setup: () => undefined,
    act: (h) => h.state.ask("   ", null, null),
  },
];

describe("one update path", () => {
  it.each(acceptedRows)("$name publishes one whole state", ({ setup, act }) => {
    const h = createHarness();
    setup(h);
    const before = h.published.length;
    act(h);
    expect(h.published.length).toBe(before + 1);
    expect(h.last()).toEqual(h.state.displayState());
  });

  it.each(droppedRows)(
    "$name publishes, sends and says nothing",
    ({ setup, act }) => {
      const h = createHarness();
      setup(h);
      const before = counts(h);
      act(h);
      expect(counts(h)).toEqual(before);
    },
  );
});

describe("re-entry", () => {
  it("publishes before it sends, even when the engine replies inside send", () => {
    const h = createHarness();
    h.replyWith((command) =>
      command.type === "runTask"
        ? {
            type: "result",
            taskId: command.taskId,
            spokenLine: "Hi.",
            findings: findings("Hi."),
          }
        : null,
    );
    h.state.ask("hi", null, null);
    h.state.receive(intake("t1", newTask("hermes")));
    expect(h.timeline).toEqual([
      "publish",
      "send question t1",
      "publish",
      "send runTask t1",
      "say startLine",
      "publish",
      "say answer",
    ]);
    expect(h.card("t1")?.state).toBe("done");
  });

  it("frees the slot when the engine answers cancel inside send", () => {
    const h = createHarness();
    h.replyWith((command) =>
      command.type === "cancel"
        ? { type: "cancelled", taskId: command.taskId, findings: null }
        : null,
    );
    oneQueued(h);
    const before = h.published.length;
    h.state.cancelTask("t1");
    expect(h.published.length).toBe(before + 2);
    expect(h.card("t1")?.state).toBe("cancelled");
    expect(h.card("t2")?.state).toBe("running");
    expect(h.sent.map((c) => `${c.type} ${c.taskId}`).slice(-2)).toEqual([
      "cancel t1",
      "runTask t2",
    ]);
  });
});
