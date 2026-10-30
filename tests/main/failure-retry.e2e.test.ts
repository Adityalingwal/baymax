import { afterEach, describe, expect, it } from "vitest";
import type { FailureCause } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import {
  closePorts,
  startFakeEngine,
  unreachable,
  until,
} from "./tasks/flow.harness";
import { decision, findings, workOnRoute } from "./tasks/harness";
import { admitAs, streamFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

const retryRoute = (taskId: string) => decision({ route: "retry", taskId });

const failTask = (w: Wired, taskId = "t1", cause: FailureCause = "error") =>
  w.port.emit({
    type: "failed",
    taskId,
    cause,
    reason: null,
    findings: findings("- Page one"),
  });

const hermesRun = {
  type: "runTask",
  taskId: "t1",
  goalVersion: 1,
  depth: "normal",
  ask: { goal: "hermes", userWords: "tell me hermes" },
  parent: null,
};

// A running task that failed, its front line played out.
async function failedTask(w: Wired): Promise<void> {
  await admitAs(w, "hermes");
  await w.playAll();
  failTask(w);
}

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
      sourcesRead: 0,
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
