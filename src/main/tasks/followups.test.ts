import { describe, expect, it } from "vitest";
import type { ParentResult } from "../../shared/engine";
import type { Harness } from "./harness";
import {
  askClarify,
  askFollowUp,
  askNew,
  createHarness,
  findings,
  finish,
  followUp,
  intake,
  newTask,
} from "./harness";

function lastRun(h: Harness, taskId: string) {
  return h.sent
    .filter((c) => c.type === "runTask" && c.taskId === taskId)
    .at(-1);
}

function parentOf(h: Harness, taskId: string): ParentResult | null | undefined {
  const command = lastRun(h, taskId);
  return command?.type === "runTask" ? command.parent : undefined;
}

type EndRow = { name: string; end: (h: Harness) => void; parent: ParentResult };

const endRows: EndRow[] = [
  {
    name: "done",
    end: (h) => finish(h, "t1"),
    parent: { taskId: "t1", outcome: "done", findings: findings("Done.") },
  },
  {
    name: "incomplete with partial findings",
    end: (h) =>
      h.state.receive({
        type: "incomplete",
        taskId: "t1",
        incomplete: { kind: "limitHit", findings: findings("Part.") },
      }),
    parent: {
      taskId: "t1",
      outcome: "incomplete",
      findings: findings("Part."),
    },
  },
  {
    name: "incomplete with no findings",
    end: (h) =>
      h.state.receive({
        type: "incomplete",
        taskId: "t1",
        incomplete: { kind: "sourcesThin", findings: null },
      }),
    parent: { taskId: "t1", outcome: "incomplete", findings: null },
  },
  {
    name: "cancelled with the cancelled event's findings",
    end: (h) => {
      h.state.cancelTask("t1");
      h.state.receive({
        type: "cancelled",
        taskId: "t1",
        findings: findings("Cut."),
      });
    },
    parent: { taskId: "t1", outcome: "cancelled", findings: findings("Cut.") },
  },
  {
    name: "cancelled with a racing result's findings",
    end: (h) => {
      h.state.cancelTask("t1");
      finish(h, "t1", "Raced.");
    },
    parent: {
      taskId: "t1",
      outcome: "cancelled",
      findings: findings("Raced."),
    },
  },
];

const invalidParentRows: {
  name: string;
  setup: (h: Harness) => void;
  parentId: string;
}[] = [
  { name: "an unknown task", setup: () => undefined, parentId: "t9" },
  { name: "itself", setup: () => undefined, parentId: "t1" },
  {
    name: "a task created after it",
    setup: (h) => h.state.ask("later", null, null),
    parentId: "t2",
  },
];

describe("follow-up parents", () => {
  it.each(endRows)(
    "a parent ended $name reaches runTask.parent",
    ({ end, parent }) => {
      const h = createHarness();
      askNew(h, "hermes");
      end(h);
      const child = askFollowUp(h, "t1", "more");
      expect(parentOf(h, child)).toEqual(parent);
      expect(h.card(child)?.parentTaskId).toBe("t1");
    },
  );

  it("gives a follow-up queued while its parent runs the parent's final result when it starts", () => {
    const h = createHarness();
    askNew(h, "hermes");
    const child = askFollowUp(h, "t1", "more");
    expect(h.card(child)?.state).toBe("queued");
    finish(h, "t1", "Final.");
    expect(parentOf(h, child)).toEqual({
      taskId: "t1",
      outcome: "done",
      findings: findings("Final."),
    });
  });
});

describe("invalid and closed parents", () => {
  it.each(invalidParentRows)(
    "runs a follow-up naming $name with parent null",
    ({ setup, parentId }) => {
      const h = createHarness();
      h.state.ask("first", null, null);
      setup(h);
      h.state.receive(intake("t1", followUp(parentId, "more")));
      expect(parentOf(h, "t1")).toBeNull();
      expect(h.card("t1")?.parentTaskId).toBeNull();
      expect(h.logs.some((line) => line.includes(`parent ${parentId}`))).toBe(
        true,
      );
    },
  );

  it("binds to a closed parent card", () => {
    const h = createHarness();
    askNew(h, "hermes");
    finish(h, "t1");
    h.state.closeCard("t1");
    const child = askFollowUp(h, "t1", "more");
    expect(parentOf(h, child)).toMatchObject({ taskId: "t1", outcome: "done" });
  });

  it("refuses a fourth waiting follow-up like a new task", () => {
    const h = createHarness();
    for (const name of ["hermes", "rust", "zig", "go"]) askNew(h, name);
    const child = askFollowUp(h, "t1", "more");
    expect(h.card(child)).toMatchObject({
      state: "cancelled",
      line: "I already have three waiting. Cancel one or ask again later.",
    });
    expect(lastRun(h, child)).toBeUndefined();
  });
});

describe("follow-ups that wait for their parent", () => {
  it("keeps waiting while a later new task runs, and runs after a clarifying parent ends", () => {
    const h = createHarness();
    askClarify(h, "q1");
    const child = askFollowUp(h, "t1", "more");
    const later = askNew(h, "rust");
    expect(h.card(child)?.state).toBe("queued");
    expect(h.card(later)?.state).toBe("running");
    h.state.answerQuestion({
      taskId: "t1",
      questionId: "q1",
      reply: { kind: "choice", index: 0 },
    });
    h.state.receive(intake("t1", newTask("about q1")));
    finish(h, later);
    expect(h.card("t1")?.state).toBe("running");
    expect(h.card(child)?.state).toBe("queued");
    finish(h, "t1");
    expect(parentOf(h, child)).toMatchObject({ taskId: "t1", outcome: "done" });
  });

  it("starts a waiting follow-up when its clarifying parent is cancelled with the slot free", () => {
    const h = createHarness();
    askClarify(h, "q1");
    const child = askFollowUp(h, "t1", "more");
    expect(h.card(child)?.state).toBe("queued");
    h.state.cancelTask("t1");
    expect(parentOf(h, child)).toEqual({
      taskId: "t1",
      outcome: "cancelled",
      findings: null,
    });
  });
});

describe("a deleted parent", () => {
  it("runs with parent null when the parent's thinking card is deleted by the answer route", () => {
    const h = createHarness();
    askClarify(h, "q1");
    h.state.ask("the first one", null, null);
    const child = askFollowUp(h, "t2", "more");
    expect(h.card(child)?.state).toBe("queued");
    h.state.receive(
      intake("t2", {
        route: "answer",
        waitingTaskId: "t1",
        questionId: "q1",
        reply: { kind: "choice", index: 0 },
      }),
    );
    expect(h.card("t2")).toBeUndefined();
    expect(parentOf(h, child)).toBeNull();
    expect(h.card(child)?.parentTaskId).toBeNull();
  });
});

const exchange = (
  taskId: string,
  state: string,
  question: string,
  answer: string | null,
  cardText: string | null,
) => ({ taskId, state, question, answer, cardText });

describe("recent exchanges", () => {
  it("carries the last 5 tasks, closed ones included, with the spoken line only for done ones", () => {
    const h = createHarness();
    for (const name of ["a", "b"]) {
      finish(h, askNew(h, name));
      h.state.closeCard(h.lastTaskId());
    }
    askNew(h, "c");
    h.state.receive({
      type: "incomplete",
      taskId: "t3",
      incomplete: { kind: "limitHit", findings: null },
    });
    askNew(h, "d");
    h.state.ask("e", null, null);
    h.state.ask("f", null, null);
    h.state.ask("g", null, null);
    const command = h.sent.at(-1);
    expect(command).toMatchObject({ type: "question", taskId: "t7" });
    expect(command?.type === "question" ? command.recent : null).toEqual([
      exchange("t2", "done", "tell me b", "Done. spoken", "Done."),
      exchange("t3", "incomplete", "tell me c", null, null),
      exchange("t4", "running", "tell me d", null, null),
      exchange("t5", "thinking", "e", null, null),
      exchange("t6", "thinking", "f", null, null),
    ]);
  });
});
