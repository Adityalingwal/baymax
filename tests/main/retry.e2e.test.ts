import { afterEach, describe, expect, it } from "vitest";
import { ipcChannels } from "../../src/shared/ipc";
import {
  ask,
  failedTask,
  failTask,
  lastTurn,
  newResult,
  offerLine,
  retryRoute,
} from "./failure.harness";
import {
  closePorts,
  startFakeEngine,
  unreachable,
  until,
} from "./tasks/flow.harness";
import {
  askRoute,
  decision,
  findings,
  replyRoute,
  workOnRoute,
  workRoute,
} from "./tasks/harness";
import { admitAs, streamFront, wire } from "./wiring.harness";

const hermesRun = {
  type: "runTask",
  taskId: "t1",
  goalVersion: 1,
  depth: "normal",
  ask: { goal: "hermes", userWords: "tell me hermes" },
  parent: null,
};

describe("a retry that fails again", () => {
  it("tells the talker it was already tried again, and offers nothing", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "yes");
    await streamFront(w, retryRoute("t1"), "Trying again.");
    await w.playAll();
    failTask(w);
    expect(lastTurn(w)).toContain(
      "on screen: some of what it found\nnext step: Say you couldn't get it done and make one short ask that fits the request. Don't offer to try again.\nalready tried again\n</task_failed>",
    );
    await streamFront(w, replyRoute(), "It failed again, sorry.");
    expect(w.card("t1")).toMatchObject({ state: "failed", canRetry: true });
    ask(w, "ok");
    expect(lastTurn(w)).not.toContain("open retry offer");
  });
});

describe("an open retry offer", () => {
  it("reaches the model for a task outside the recent window, and a yes runs it", async () => {
    const w = wire();
    await failedTask(w);
    for (let i = 0; i < 6; i += 1) {
      ask(w, `hi ${i}`);
      await streamFront(w, replyRoute(), `Hello ${i}.`);
    }
    ask(w, "yes, that hermes one");
    const turn = lastTurn(w);
    expect(turn).not.toContain("- task t1 (failed)");
    expect(turn).toContain(
      "- open retry offer 1: task t1 | title: hermes\nlatest open retry offer: 1\n</recent>",
    );
    await streamFront(w, retryRoute("t1"), "Trying again.");
    expect(w.card("t1")?.state).toBe("running");
    ask(w, "ok");
    expect(lastTurn(w)).not.toContain("open retry offer");
  });

  it("marks the latest offer made, whatever order the tasks were asked in", async () => {
    const w = wire();
    ask(w, "a good laptop");
    await streamFront(w, askRoute("laptops"), "What budget?");
    await admitAs(w, "hermes");
    ask(w, "under a thousand");
    await streamFront(
      w,
      workRoute("laptops", "t1:question"),
      "Laptops after this.",
    );
    expect(w.card("t1")?.state).toBe("queued");
    failTask(w, "t2");
    expect(w.card("t1")?.state).toBe("running");
    await streamFront(w, replyRoute(), "Hermes failed. Try again?");
    failTask(w, "t1");
    await streamFront(w, replyRoute(), "Laptops failed. Try again?");
    ask(w, "yes");
    expect(lastTurn(w)).toContain(
      "- open retry offer 1: task t2 | title: hermes\n- open retry offer 2: task t1 | title: laptops\nlatest open retry offer: 2\n</recent>",
    );
  });
});

describe("the finish order on the cards", () => {
  it("gives a retried older task a higher number than a newer one, and none while it runs", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await admitAs(w, "laptops");
    failTask(w, "t1");
    await streamFront(w, replyRoute(), "Hermes failed. Try again?");
    w.port.emit({ ...newResult, taskId: "t2" });
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(w.card("t1")?.finishOrder).toBeNull();
    w.port.emit(newResult);
    const finished = (taskId: string) => w.card(taskId)?.finishOrder ?? 0;
    expect(finished("t1")).toBeGreaterThan(finished("t2"));
  });
});

describe("a yes routed retry", () => {
  it("runs the same task again with its saved ask and leaves no card from the yes", async () => {
    const w = wire();
    await failedTask(w);
    expect(w.card("t1")).toMatchObject({ state: "failed", canRetry: true });
    ask(w, "yes please");
    await streamFront(w, retryRoute("t1"), "Trying again.");
    expect(w.port.sent.at(-1)).toEqual(hermesRun);
    expect(w.port.sent).toHaveLength(2);
    expect(w.card("t1")).toMatchObject({
      state: "running",
      line: null,
      answer: null,
      canRetry: false,
    });
    const shown = w.published.at(-1)?.tasks.map((card) => card.taskId);
    expect(shown).toEqual(["t1"]);
    expect(w.chat().slice(-2)).toEqual(["yes please", "Trying again."]);
  });

  it("with answerTo is rejected", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "yes");
    await streamFront(
      w,
      decision({ route: "retry", taskId: "t1", answerTo: "t1:question" }),
    );
    expect(w.logs).toContain("decision rejected for t2: answerOnRetry");
    expect(w.card("t1")?.state).toBe("failed");
    expect(w.port.sent).toHaveLength(1);
  });

  it("is stale once the task is no longer failed: rejected, nothing starts", async () => {
    const w = wire();
    await failedTask(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    const sent = w.port.sent.length;
    ask(w, "yes");
    await streamFront(w, retryRoute("t1"));
    expect(w.logs).toContain("decision rejected for t2: cannotRetry");
    expect(w.port.sent).toHaveLength(sent);
    expect(w.card("t1")?.state).toBe("running");
  });
});

describe("a yes whose call started before the task's latest failure", () => {
  it("is rejected and does not run the newer failure again", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "yes");
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    failTask(w);
    const sent = w.port.sent.length;
    await streamFront(w, retryRoute("t1"), "Trying again.");
    expect(w.logs).toContain("decision rejected for t2: cannotRetry");
    expect(w.port.sent).toHaveLength(sent);
    expect(w.card("t1")?.state).toBe("failed");
  });
});

describe("Retry on the card", () => {
  it("runs the task again and speaks nothing", async () => {
    const w = wire();
    await failedTask(w);
    const said = w.syntheses.length;
    const calls = w.talkerCalls.length;
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(w.port.sent.at(-1)).toEqual(hermesRun);
    expect(w.card("t1")).toMatchObject({ state: "running", canRetry: false });
    expect(w.syntheses).toHaveLength(said);
    expect(w.talkerCalls).toHaveLength(calls);
  });

  it("stays after a second failure and runs again", async () => {
    const w = wire();
    await failedTask(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    failTask(w);
    expect(w.card("t1")).toMatchObject({ state: "failed", canRetry: true });
    await streamFront(w, replyRoute(), "It failed again, sorry.");
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(w.port.sent).toHaveLength(3);
    expect(w.port.sent.at(-1)).toEqual(hermesRun);
  });
});

describe("a retried task through the real engine", () => {
  afterEach(closePorts);

  it("reaches the worker again under the same id", async () => {
    const engine = startFakeEngine([unreachable, unreachable]);
    const w = wire({ port: engine.port });
    await admitAs(w, "hermes");
    await until("the first failure", () => w.card("t1")?.state === "failed");
    await streamFront(w, replyRoute(), offerLine);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    await until("the second failure", () => w.card("t1")?.state === "failed");
    expect(engine.requests).toHaveLength(2);
  });
});

describe("a follow-up after a retry succeeded", () => {
  it("gets the new result as its parent", async () => {
    const w = wire();
    await failedTask(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    w.port.emit({
      type: "result",
      taskId: "t1",
      spokenLine: "Hermes runs a loop.",
      findings: findings("Hermes runs a loop."),
    });
    ask(w, "and in detail?");
    await streamFront(w, workOnRoute("t1", "more"), "Looking deeper.");
    expect(w.port.sent.at(-1)).toMatchObject({
      type: "runTask",
      parent: {
        taskId: "t1",
        outcome: "done",
        spokenLine: "Hermes runs a loop.",
        findings: findings("Hermes runs a loop."),
      },
    });
  });
});

describe("a follow-up queued behind a failed task that is retried", () => {
  it("waits for the new result and never runs with the old failed parent", async () => {
    const w = wire();
    await failedTask(w);
    await admitAs(w, "busy");
    ask(w, "more on hermes");
    await streamFront(w, workOnRoute("t1", "more"), "After this.");
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    w.port.emit({
      type: "result",
      taskId: "t2",
      spokenLine: "Busy.",
      findings: findings("Busy."),
    });
    expect(w.port.sent.at(-1)).toEqual(hermesRun);
    expect(w.card("t3")?.state).toBe("queued");
    w.port.emit(newResult);
    expect(w.port.sent.at(-1)).toMatchObject({
      type: "runTask",
      taskId: "t3",
      parent: { taskId: "t1", outcome: "done", findings: newResult.findings },
    });
  });
});
