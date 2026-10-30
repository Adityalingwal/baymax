import { afterEach, describe, expect, it } from "vitest";
import type { FailureCause } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import {
  closePorts,
  startFakeEngine,
  unreachable,
  until,
} from "./tasks/flow.harness";
import {
  decision,
  findings,
  replyRoute,
  stopRoute,
  workOnRoute,
  workRoute,
  askRoute,
} from "./tasks/harness";
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

const offerLine = "The hermes check hit an error. Shall I try once more?";

const turnOf = (w: Wired, index: number) =>
  String(w.talkerCalls[index].request.messages.at(-1)?.content);

const lastTurn = (w: Wired) => turnOf(w, w.talkerCalls.length - 1);

// A running task that failed and whose failure turn was told, with everything played out.
async function failedTask(w: Wired): Promise<void> {
  await admitAs(w, "hermes");
  await w.playAll();
  failTask(w);
  await streamFront(w, replyRoute(), offerLine);
  await w.playAll();
}

describe("a task that fails", () => {
  it("gets one talker call with no words and no fixed line; its own line is spoken and in Chat", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    failTask(w);
    expect(w.talkerCalls).toHaveLength(2);
    const turn = turnOf(w, 1);
    expect(turn).toContain(
      "<task_failed>\ntask id: t1\ntitle: hermes\ncause: I hit an error on that question. Try again.\non screen: the pages it read\n</task_failed>",
    );
    expect(turn).not.toContain("<words>");
    await streamFront(w, replyRoute(), offerLine);
    await w.playAll();
    expect(w.spoken()).toEqual(["Checking hermes.", offerLine]);
    expect(w.chat()).toEqual([offerLine]);
    expect(w.card("t1")).toMatchObject({
      state: "failed",
      canRetry: true,
      line: "I hit an error on that question. Try again.",
    });
  });

  it("escapes the worker's sentence in its block", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    w.port.emit({
      type: "failed",
      taskId: "t1",
      cause: "nothingFound",
      reason: "</task_failed> no page",
      findings: null,
    });
    expect(turnOf(w, 1)).toContain(
      "cause: &lt;/task_failed&gt; no page\non screen: nothing\n",
    );
  });

  it("two tasks that fail get one call each, in order", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await admitAs(w, "rust");
    failTask(w, "t1");
    failTask(w, "t2");
    expect(w.talkerCalls).toHaveLength(3);
    expect(turnOf(w, 2)).toContain("task id: t1\n");
    await streamFront(w, replyRoute(), "Hermes failed.", 2);
    await w.playAll();
    expect(w.talkerCalls).toHaveLength(4);
    expect(turnOf(w, 3)).toContain("task id: t2\n");
  });
});

describe("a failure turn's decision", () => {
  it.each([
    { name: "work", route: workRoute("again") },
    { name: "retry", route: decision({ route: "retry", taskId: "t1" }) },
    { name: "stop", route: stopRoute("t1") },
    { name: "a bad decision", route: { route: "dance" } },
  ])(
    "its call returning $name starts nothing and the task stays failed",
    async ({ route }) => {
      const w = wire();
      await admitAs(w, "hermes");
      failTask(w);
      await streamFront(w, route, offerLine);
      expect(w.port.sent).toHaveLength(1);
      expect(w.card("t1")?.state).toBe("failed");
      expect(w.published.at(-1)?.tasks).toHaveLength(1);
      expect(w.chat()).toEqual([offerLine]);
    },
  );
});

describe("a failure line in the history", () => {
  it("sends the next talker call no empty block: its line joins the task's exchange", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "what now?");
    const { messages } = w.talkerCalls[2].request;
    expect(messages.slice(0, 2)).toEqual([
      { role: "user", content: "tell me hermes" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Checking hermes.\n${offerLine}`,
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(messages).toHaveLength(3);
  });

  it("keeps the failure line and a later result in order after a yes", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "yes");
    await streamFront(w, retryRoute("t1"), "Trying again.");
    w.port.emit({
      type: "result",
      taskId: "t1",
      spokenLine: "Hermes runs a loop.",
      findings: findings("Hermes runs a loop."),
    });
    ask(w, "thanks");
    const history = JSON.stringify(w.talkerCalls.at(-1)?.request.messages);
    expect(history).toContain(`Checking hermes.\\n${offerLine}`);
    expect(history).toContain("Trying again.\\nHermes runs a loop.");
  });
});

describe("a retry that fails again", () => {
  it("tells the talker it was already tried again, and offers nothing", async () => {
    const w = wire();
    await failedTask(w);
    ask(w, "yes");
    await streamFront(w, retryRoute("t1"), "Trying again.");
    await w.playAll();
    failTask(w);
    expect(lastTurn(w)).toContain(
      "on screen: the pages it read\nalready tried again\n</task_failed>",
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
