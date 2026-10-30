import { describe, expect, it } from "vitest";
import type { TaskState } from "../../shared/cards";
import type { Harness } from "./harness";
import { askNew, counts, createHarness, findings, finish } from "./harness";

type Setup = (h: Harness) => void;

const thinking: Setup = (h) => h.state.ask("hi", null, null);
const failed: Setup = (h) => {
  thinking(h);
  h.replyFailed("t1", "modelsUnreachable");
};
const running: Setup = (h) => {
  askNew(h, "hermes");
};
const queued: Setup = (h) => {
  askNew(h, "hermes");
  askNew(h, "rust");
};
const done: Setup = (h) => {
  running(h);
  finish(h, "t1");
};
const incomplete: Setup = (h) => {
  running(h);
  h.state.receive({
    type: "incomplete",
    taskId: "t1",
    incomplete: { kind: "limitHit", findings: findings("Part.") },
  });
};
const cancelling: Setup = (h) => {
  running(h);
  h.state.cancelTask("t1");
};
const cancelled: Setup = (h) => {
  cancelling(h);
  h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
};

type CancelRow = {
  name: string;
  setup: Setup;
  taskId: string;
  state: TaskState;
  sendsCancel: boolean;
};

const cancelRows: CancelRow[] = [
  {
    name: "thinking, front call in flight",
    setup: thinking,
    taskId: "t1",
    state: "cancelled",
    sendsCancel: false,
  },
  {
    name: "thinking after a failure",
    setup: failed,
    taskId: "t1",
    state: "cancelled",
    sendsCancel: false,
  },
  {
    name: "queued",
    setup: queued,
    taskId: "t2",
    state: "cancelled",
    sendsCancel: false,
  },
  {
    name: "running",
    setup: running,
    taskId: "t1",
    state: "cancelling",
    sendsCancel: true,
  },
];

const droppedCancelRows: { name: string; setup: Setup; taskId: string }[] = [
  { name: "cancelling", setup: cancelling, taskId: "t1" },
  { name: "done", setup: done, taskId: "t1" },
  { name: "incomplete", setup: incomplete, taskId: "t1" },
  { name: "cancelled", setup: cancelled, taskId: "t1" },
  { name: "unknown", setup: running, taskId: "t9" },
];

describe("cancel and the card", () => {
  it.each(cancelRows)(
    "cancel on $name",
    ({ setup, taskId, state, sendsCancel }) => {
      const h = createHarness();
      setup(h);
      const sentBefore = h.sent.length;
      h.state.cancelTask(taskId);
      expect(h.card(taskId)?.state).toBe(state);
      expect(h.sent.slice(sentBefore)).toEqual(
        sendsCancel ? [{ type: "cancel", taskId }] : [],
      );
    },
  );

  it.each(droppedCancelRows)(
    "cancel on $name is dropped",
    ({ setup, taskId }) => {
      const h = createHarness();
      setup(h);
      const before = counts(h);
      h.state.cancelTask(taskId);
      expect(counts(h)).toEqual(before);
    },
  );
});

describe("cancelling", () => {
  it("stays cancelling until the engine replies", () => {
    const h = createHarness();
    cancelling(h);
    h.advance(60000);
    expect(h.card("t1")?.state).toBe("cancelling");
    h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
    expect(h.card("t1")?.state).toBe("cancelled");
  });

  it("frees the slot on an unasked cancelled event", () => {
    const h = createHarness();
    askNew(h, "hermes");
    askNew(h, "rust");
    h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
    expect(h.card("t1")?.state).toBe("cancelled");
    expect(h.card("t2")?.state).toBe("running");
  });
});

describe("card lifetime", () => {
  it.each([
    { name: "done", setup: done },
    { name: "incomplete", setup: incomplete },
  ])("keeps a $name card after 60000 ms", ({ setup }) => {
    const h = createHarness();
    setup(h);
    h.advance(60000);
    expect(h.card("t1")).toBeDefined();
  });

  it("shows a cancelled card at 2999 ms and removes it at 3000 ms", () => {
    const h = createHarness();
    cancelled(h);
    h.advance(2999);
    expect(h.card("t1")?.state).toBe("cancelled");
    h.advance(1);
    expect(h.card("t1")).toBeUndefined();
  });
});
