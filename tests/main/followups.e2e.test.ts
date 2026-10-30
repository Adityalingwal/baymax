import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "../../src/shared/cards";
import type { EngineEvent, ParentResult } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import { clarify, findings, followUp, newTask } from "./tasks/harness";
import type { ModelRequest } from "./tasks/flow.harness";
import {
  closePorts,
  startFakeEngine,
  unreachable,
  until,
} from "./tasks/flow.harness";
import { admitAs, streamFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

afterEach(closePorts);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

// The id of the card the last ask added: new cards are shown last.
const lastCard = (w: Wired): TaskId => {
  const taskId = w.published.at(-1)?.tasks.at(-1)?.taskId;
  if (taskId === undefined) throw new Error("no card");
  return taskId;
};

async function askFollowUp(w: Wired, parent: TaskId, topic: string) {
  ask(w, `and ${topic}`);
  const taskId = lastCard(w);
  const call = w.talkerCalls.length - 1;
  await streamFront(w, followUp(parent, topic), `Checking ${topic}.`, call);
  return taskId;
}

async function clarifyingParent(w: Wired): Promise<void> {
  ask(w, "about it");
  await streamFront(w, clarify(), "Which one for t1?");
}

const lastRun = (w: Wired, taskId: TaskId) =>
  w.port.sent.filter((c) => c.type === "runTask" && c.taskId === taskId).at(-1);

function parentOf(w: Wired, taskId: TaskId): ParentResult | null | undefined {
  const command = lastRun(w, taskId);
  return command?.type === "runTask" ? command.parent : undefined;
}

const result = (taskId: TaskId, text = "Done."): EngineEvent => ({
  type: "result",
  taskId,
  spokenLine: `${text} spoken`,
  findings: findings(text),
});

const incomplete = (found: boolean): EngineEvent => ({
  type: "incomplete",
  taskId: "t1",
  incomplete: { kind: "limitHit", findings: found ? findings("Part.") : null },
});

function cancelled(w: Wired, found: boolean): void {
  w.send(ipcChannels.cancelTask, { taskId: "t1" });
  w.port.emit({
    type: "cancelled",
    taskId: "t1",
    findings: found ? findings("Cut.") : null,
  });
}

type EndRow = { name: string; end: (w: Wired) => void; parent: ParentResult };

const endRows: EndRow[] = [
  {
    name: "done",
    end: (w) => w.port.emit(result("t1")),
    parent: { taskId: "t1", outcome: "done", findings: findings("Done.") },
  },
  {
    name: "incomplete with partial findings",
    end: (w) => w.port.emit(incomplete(true)),
    parent: {
      taskId: "t1",
      outcome: "incomplete",
      findings: findings("Part."),
    },
  },
  {
    name: "incomplete with no findings",
    end: (w) =>
      w.port.emit({
        type: "incomplete",
        taskId: "t1",
        incomplete: { kind: "sourcesThin", findings: null },
      }),
    parent: { taskId: "t1", outcome: "incomplete", findings: null },
  },
  {
    name: "cancelled with the cancelled event's findings",
    end: (w) => cancelled(w, true),
    parent: { taskId: "t1", outcome: "cancelled", findings: findings("Cut.") },
  },
  {
    name: "cancelled with a racing result's findings",
    end: (w) => {
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
      w.port.emit(result("t1", "Raced."));
    },
    parent: {
      taskId: "t1",
      outcome: "cancelled",
      findings: findings("Raced."),
    },
  },
  {
    name: "cancelled with a racing incomplete's findings",
    end: (w) => {
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
      w.port.emit(incomplete(true));
    },
    parent: {
      taskId: "t1",
      outcome: "cancelled",
      findings: findings("Part."),
    },
  },
];

describe("follow-up parents", () => {
  it.each(endRows)(
    "a parent ended $name reaches runTask.parent",
    async ({ end, parent }) => {
      const w = wire();
      await admitAs(w, "hermes");
      end(w);
      const child = await askFollowUp(w, "t1", "more");
      expect(parentOf(w, child)).toEqual(parent);
      expect(w.card(child)?.parentTaskId).toBe("t1");
    },
  );

  it("gives a follow-up queued while its parent runs the parent's final result when it starts", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    const child = await askFollowUp(w, "t1", "more");
    expect(w.card(child)?.state).toBe("queued");
    w.port.emit(result("t1", "Final."));
    expect(parentOf(w, child)).toEqual({
      taskId: "t1",
      outcome: "done",
      findings: findings("Final."),
    });
  });
});

const invalidParentRows: {
  name: string;
  setup: (w: Wired) => void;
  parentId: TaskId;
}[] = [
  { name: "an unknown task", setup: () => undefined, parentId: "t9" },
  { name: "itself", setup: () => undefined, parentId: "t1" },
  {
    name: "a task created after it",
    setup: (w) => ask(w, "later"),
    parentId: "t2",
  },
];

describe("invalid parents and the queue", () => {
  it.each(invalidParentRows)(
    "runs a follow-up naming $name with parent null",
    async ({ setup, parentId }) => {
      const w = wire();
      ask(w, "first");
      setup(w);
      await streamFront(w, followUp(parentId, "more"), "Okay.", 0);
      expect(parentOf(w, "t1")).toBeNull();
      expect(w.card("t1")?.parentTaskId).toBeNull();
      expect(w.logs.some((line) => line.includes(`parent ${parentId}`))).toBe(
        true,
      );
    },
  );

  it("refuses a fourth waiting follow-up like a new task", async () => {
    const w = wire();
    for (const name of ["hermes", "rust", "zig", "go"]) await admitAs(w, name);
    const child = await askFollowUp(w, "t1", "more");
    expect(w.card(child)).toMatchObject({
      state: "cancelled",
      line: "I already have three waiting. Cancel one or ask again later.",
    });
    expect(lastRun(w, child)).toBeUndefined();
  });
});

describe("follow-ups that wait for their parent", () => {
  it("keeps waiting while a later new task runs, and runs after a clarifying parent ends", async () => {
    const w = wire();
    await clarifyingParent(w);
    const child = await askFollowUp(w, "t1", "more");
    await admitAs(w, "rust");
    const later = lastCard(w);
    expect(w.card(child)?.state).toBe("queued");
    expect(w.card(later)?.state).toBe("running");
    ask(w, "the first one");
    await streamFront(w, newTask("about it", "t1:question"));
    w.port.emit(result(later));
    expect(w.card("t1")?.state).toBe("running");
    expect(w.card(child)?.state).toBe("queued");
    w.port.emit(result("t1"));
    expect(parentOf(w, child)).toMatchObject({ taskId: "t1", outcome: "done" });
  });

  it("starts a waiting follow-up when its clarifying parent is cancelled with the slot free", async () => {
    const w = wire();
    await clarifyingParent(w);
    const child = await askFollowUp(w, "t1", "more");
    expect(w.card(child)?.state).toBe("queued");
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    expect(parentOf(w, child)).toEqual({
      taskId: "t1",
      outcome: "cancelled",
      findings: null,
    });
  });

  it("runs with parent null when the parent's thinking card is deleted by the answer route", async () => {
    const w = wire();
    await clarifyingParent(w);
    ask(w, "the first one");
    const answer = lastCard(w);
    const child = await askFollowUp(w, answer, "more");
    expect(w.card(child)?.state).toBe("queued");
    await streamFront(w, newTask("about it", "t1:question"), "Okay.", 1);
    expect(w.card(answer)).toBeUndefined();
    // The answered task runs first; the follow-up starts once the slot frees.
    w.port.emit(result("t1"));
    expect(parentOf(w, child)).toBeNull();
    expect(w.card(child)?.parentTaskId).toBeNull();
  });
});

const label = "Built on the partial findings of an earlier question.";

type ParentEnd = {
  name: string;
  end: (w: Wired) => void;
  line: string | null; // the partial-parent line; null for a done parent, which shows no line
  labelled: boolean;
};

const parentEnds: ParentEnd[] = [
  {
    name: "incomplete with findings",
    end: (w) => w.port.emit(incomplete(true)),
    line: "Hermes ended without a full answer, so I'll build on what it found.",
    labelled: true,
  },
  {
    name: "incomplete without findings",
    end: (w) => w.port.emit(incomplete(false)),
    line: "Hermes ended before it found anything.",
    labelled: false,
  },
  {
    name: "cancelled with findings",
    end: (w) => cancelled(w, true),
    line: "Hermes was cancelled, so I'll build on what it found.",
    labelled: true,
  },
  {
    name: "cancelled without findings",
    end: (w) => cancelled(w, false),
    line: "Hermes was cancelled before it found anything.",
    labelled: false,
  },
  {
    name: "cancelled, ended by an incomplete",
    end: (w) => {
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
      w.port.emit(incomplete(true));
    },
    line: "Hermes was cancelled, so I'll build on what it found.",
    labelled: true,
  },
  {
    name: "done",
    end: (w) => w.port.emit(result("t1")),
    line: null,
    labelled: false,
  },
];

const afterEnded = "asked after the parent ended";
const queued = "queued while the parent ran";

const rows = parentEnds.flatMap((parentEnd) =>
  [afterEnded, queued].map((start) => ({ ...parentEnd, start })),
);

// The partial-parent line and the queued line show on the card only; main says neither.
describe("a follow-up of a parent that did not end done", () => {
  it.each(rows)(
    "parent $name, $start: card line, said lines and done label",
    async ({ end, line, labelled, start }) => {
      const w = wire();
      await admitAs(w, "hermes");
      let child: TaskId;
      if (start === afterEnded) {
        end(w);
        child = await askFollowUp(w, "t1", "more");
      } else {
        child = await askFollowUp(w, "t1", "more");
        expect(w.card(child)?.state).toBe("queued");
        end(w);
      }
      expect(w.card(child)).toMatchObject({ state: "running", line });
      await flush();
      await w.playAll();
      if (line !== null) expect(w.spoken()).not.toContain(line);
      w.port.emit(result(child));
      expect(w.card(child)).toMatchObject({
        state: "done",
        line: labelled ? label : null,
      });
    },
  );

  it("names the parent 'The earlier question' when it was cancelled before it had a topic", async () => {
    const w = wire();
    ask(w, "first");
    w.send(ipcChannels.cancelTask, { taskId: "t1" });
    const child = await askFollowUp(w, "t1", "more");
    const line = "The earlier question was cancelled before it found anything.";
    expect(w.card(child)).toMatchObject({ state: "running", line });
    await flush();
    await w.playAll();
    expect(w.spoken()).not.toContain(line);
  });
});

const firstText = (request: ModelRequest): string => {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : "";
};

describe("a follow-up with the real engine", () => {
  it("runs the typed demo pair over an incomplete parent", async () => {
    const engine = startFakeEngine([unreachable, unreachable]);
    const w = wire({ port: engine.port });
    ask(w, "How does Hermes agent work inside?");
    await streamFront(
      w,
      newTask("how Hermes agent works inside"),
      "I'll look at how Hermes works.",
    );
    await until("card 1 to end", () => w.card("t1")?.state === "incomplete");
    ask(w, "How is it different from Claude Code?");
    await streamFront(
      w,
      followUp("t1", "how Hermes differs from Claude Code"),
      "I'll compare them.",
      1,
    );
    await until("card 2's run", () => lastRun(w, "t2") !== undefined);
    const line =
      "How Hermes agent works inside ended before it found anything.";
    const shown = w.published
      .map((display) => display.tasks.find((task) => task.taskId === "t2"))
      .find((task) => task?.state === "running");
    expect(shown).toMatchObject({
      parentTaskId: "t1",
      line,
      reply: "I'll compare them.",
    });
    expect(lastRun(w, "t2")).toMatchObject({
      parent: { taskId: "t1", outcome: "incomplete", findings: null },
    });
    await until(
      "card 2's worker request",
      () => engine.workerRequests().length >= 2,
    );
    expect(firstText(engine.workerRequests()[1])).toContain("<parent_result>");
    await flush();
    await w.playAll();
    expect(w.spoken()).not.toContain(line);
  });
});
