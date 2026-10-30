import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "../../src/shared/cards";
import type { EngineEvent, ParentResult } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import {
  replyRoute,
  askRoute,
  findings,
  stopRoute,
  workOnRoute,
  workRoute,
} from "./tasks/harness";
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

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

async function askFollowUp(w: Wired, parent: TaskId, topic: string) {
  ask(w, `and ${topic}`);
  const taskId = w.lastId();
  const call = w.talkerCalls.length - 1;
  await streamFront(w, workOnRoute(parent, topic), `Checking ${topic}.`, call);
  return taskId;
}

async function clarifyingParent(w: Wired): Promise<void> {
  ask(w, "about it");
  await streamFront(w, askRoute(), "Which one for t1?");
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

const failed = (found: boolean): EngineEvent => ({
  type: "failed",
  taskId: "t1",
  cause: "limitHit",
  reason: null,
  findings: found ? findings("Part.") : null,
});

function cancelled(w: Wired, found: boolean): void {
  w.send(ipcChannels.cancelTask, { taskId: "t1" });
  w.port.emit({
    type: "cancelled",
    taskId: "t1",
    findings: found ? findings("Cut.") : null,
  });
}

// What admitAs(w, "hermes") saves for t1, however it ends.
const asked = {
  taskId: "t1",
  goal: "hermes",
  words: "tell me hermes",
  spokenLine: null,
};

type EndRow = { name: string; end: (w: Wired) => void; parent: ParentResult };

const endRows: EndRow[] = [
  {
    name: "done",
    end: (w) => w.port.emit(result("t1")),
    parent: {
      ...asked,
      outcome: "done",
      spokenLine: "Done. spoken",
      findings: findings("Done."),
    },
  },
  {
    name: "done with an empty report",
    end: (w) =>
      w.port.emit({
        type: "result",
        taskId: "t1",
        spokenLine: "It is 31 degrees.",
        findings: findings(""),
      }),
    parent: {
      ...asked,
      outcome: "done",
      spokenLine: "It is 31 degrees.",
      findings: findings(""),
    },
  },
  {
    name: "failed with pages",
    end: (w) => w.port.emit(failed(true)),
    parent: { ...asked, outcome: "failed", findings: findings("Part.") },
  },
  {
    name: "failed with nothing found",
    end: (w) =>
      w.port.emit({
        type: "failed",
        taskId: "t1",
        cause: "nothingFound",
        reason: "Nothing helped.",
        findings: null,
      }),
    parent: { ...asked, outcome: "failed", findings: null },
  },
  {
    name: "cancelled with the cancelled event's findings",
    end: (w) => cancelled(w, true),
    parent: { ...asked, outcome: "cancelled", findings: findings("Cut.") },
  },
  {
    name: "cancelled with a racing result's findings",
    end: (w) => {
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
      w.port.emit(result("t1", "Raced."));
    },
    parent: { ...asked, outcome: "cancelled", findings: findings("Raced.") },
  },
  {
    name: "cancelled with a racing failure's findings",
    end: (w) => {
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
      w.port.emit(failed(true));
    },
    parent: { ...asked, outcome: "cancelled", findings: findings("Part.") },
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
      expect(w.card(child)).toMatchObject({ parentTaskId: "t1", line: null });
    },
  );

  it("gives a follow-up queued while its parent runs the parent's final result when it starts", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    const child = await askFollowUp(w, "t1", "more");
    expect(w.card(child)?.state).toBe("queued");
    w.port.emit(result("t1", "Final."));
    expect(parentOf(w, child)).toEqual({
      ...asked,
      outcome: "done",
      spokenLine: "Final. spoken",
      findings: findings("Final."),
    });
    expect(w.card(child)?.line).toBeNull();
  });

  it("saves a chat result with no goal and the card's words", async () => {
    const w = wire();
    ask(w, "hello there");
    await streamFront(w, replyRoute(), "Hello.");
    const child = await askFollowUp(w, "t1", "more");
    expect(parentOf(w, child)).toEqual({
      taskId: "t1",
      outcome: "done",
      goal: null,
      words: "hello there",
      spokenLine: "Hello.",
      findings: findings("Hello."),
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
      await streamFront(w, workOnRoute(parentId, "more"), "Okay.", 0);
      expect(parentOf(w, "t1")).toBeNull();
      expect(w.card("t1")?.parentTaskId).toBeNull();
      expect(w.logs.some((line) => line.includes(`parent ${parentId}`))).toBe(
        true,
      );
    },
  );

  it("queues a fourth waiting follow-up like new work", async () => {
    const w = wire();
    for (const name of ["hermes", "rust", "zig", "go"]) await admitAs(w, name);
    const child = await askFollowUp(w, "t1", "more");
    expect(w.card(child)).toMatchObject({ state: "queued", line: null });
    expect(lastRun(w, child)).toBeUndefined();
  });
});

describe("follow-ups that wait for their parent", () => {
  it("keeps waiting while a later new task runs, and runs after a clarifying parent ends", async () => {
    const w = wire();
    await clarifyingParent(w);
    const child = await askFollowUp(w, "t1", "more");
    await admitAs(w, "rust");
    const later = w.lastId();
    expect(w.card(child)?.state).toBe("queued");
    expect(w.card(later)?.state).toBe("running");
    ask(w, "the first one");
    await streamFront(w, workRoute("about it", "t1:question"));
    w.port.emit(result(later));
    expect(w.card("t1")?.state).toBe("running");
    expect(w.card(child)?.state).toBe("queued");
    w.port.emit(result("t1"));
    expect(parentOf(w, child)).toMatchObject({ taskId: "t1", outcome: "done" });
  });

  it("starts a waiting follow-up when its clarifying parent is stopped with the slot free", async () => {
    const w = wire();
    await clarifyingParent(w);
    const child = await askFollowUp(w, "t1", "more");
    expect(w.card(child)?.state).toBe("queued");
    ask(w, "never mind that");
    await streamFront(w, stopRoute("t1"), "Dropping it.", 2);
    expect(parentOf(w, child)).toEqual({
      taskId: "t1",
      outcome: "cancelled",
      goal: null,
      words: "about it",
      spokenLine: null,
      findings: null,
    });
  });

  it("runs with parent null when the parent's thinking card is deleted by the answer route", async () => {
    const w = wire();
    await clarifyingParent(w);
    ask(w, "the first one");
    const answer = w.lastId();
    const child = await askFollowUp(w, answer, "more");
    expect(w.card(child)?.state).toBe("queued");
    await streamFront(w, workRoute("about it", "t1:question"), "Okay.", 1);
    expect(w.card(answer)).toBeUndefined();
    // The answered task runs first; the follow-up starts once the slot frees.
    w.port.emit(result("t1"));
    expect(parentOf(w, child)).toBeNull();
    expect(w.card(child)?.parentTaskId).toBeNull();
  });
});

const firstText = (request: ModelRequest): string => {
  const content = request.messages[0]?.content;
  return typeof content === "string" ? content : "";
};

describe("a follow-up with the real engine", () => {
  it("gives the worker a failed parent's goal and words", async () => {
    const engine = startFakeEngine([unreachable, unreachable]);
    const w = wire({ port: engine.port });
    ask(w, "How does Hermes agent work inside?");
    await streamFront(
      w,
      workRoute("how Hermes agent works inside"),
      "I'll look at how Hermes works.",
    );
    await until("card 1 to end", () => w.card("t1")?.state === "failed");
    ask(w, "How is it different from Claude Code?");
    await streamFront(
      w,
      workOnRoute("t1", "how Hermes differs from Claude Code"),
      "I'll compare them.",
      1,
    );
    await until("card 2's run", () => lastRun(w, "t2") !== undefined);
    const shown = w.published
      .map((display) => display.tasks.find((task) => task.taskId === "t2"))
      .find((task) => task?.state === "running");
    expect(shown).toMatchObject({
      parentTaskId: "t1",
      line: null,
    });
    expect(lastRun(w, "t2")).toMatchObject({
      parent: { taskId: "t1", outcome: "failed", findings: null },
    });
    await until("card 2's worker request", () => engine.requests.length >= 2);
    const text = firstText(engine.requests[1]);
    expect(text).toContain(
      "<parent_result>\noutcome: failed\n<goal>\nhow Hermes agent works inside\n</goal>\n<words>\nHow does Hermes agent work inside?\n</words>",
    );
    expect(text).toContain(
      "The earlier task found nothing, so there is no earlier result to build on. Work from the request you have.",
    );
  });
});
