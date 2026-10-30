import { describe, expect, it } from "vitest";
import { ipcChannels } from "../../src/shared/ipc";
import { replyRoute, askRoute, findings, workRoute } from "./tasks/harness";
import { admitAs, streamFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

// Asks and answers the front call with a clarifying question; the task is the next t id.
async function askClarify(w: Wired, words = "about it") {
  ask(w, words);
  const taskId = w.published.at(-1)?.tasks.at(-1)?.taskId ?? "";
  const call = w.talkerCalls.length - 1;
  await streamFront(w, askRoute(), `Which one for ${taskId}?`, call);
  return taskId;
}

// Typed words while a question waits; the front call answers them with the decision.
async function answerWith(
  w: Wired,
  words: string,
  decision: unknown,
  line?: string,
) {
  ask(w, words);
  const temp = w.published.at(-1)?.tasks.at(-1)?.taskId ?? "";
  await streamFront(w, decision, line, w.talkerCalls.length - 1);
  return temp;
}

const synthesized = (w: Wired, text: string) =>
  w.syntheses.filter((call) => call.input === text).length;

describe("the shown question", () => {
  it("shows the spoken line as the question and says nothing more", async () => {
    const w = wire();
    await askClarify(w);
    expect(w.card("t1")).toEqual({
      taskId: "t1",
      state: "clarifying",
      words: "about it",
      title: "about it",
      parentTaskId: null,
      sayBack: null,
      line: null,
      reply: null,
      spokenLine: null,
      step: null,
      sourcesRead: 0,
      question: {
        questionId: "t1:question",
        text: "Which one for t1?",
        answered: false,
      },
      answer: null,
      canRetry: false,
    });
    await flush();
    await w.playAll();
    expect(w.spoken()).toEqual(["Which one for t1?"]);
    expect(w.talkerCalls).toHaveLength(1);
    expect(w.wiring.state.waitingQuestion()).toEqual({
      taskId: "t1",
      words: "about it",
      question: {
        questionId: "t1:question",
        text: "Which one for t1?",
      },
    });
  });
});

type ReleaseRow = { name: string; release: (w: Wired) => Promise<void> };

const answerFirst = async (w: Wired) => {
  await answerWith(w, "the first one", workRoute("about it", "t1:question"));
};

const releaseRows: ReleaseRow[] = [
  { name: "the first is answered", release: answerFirst },
  {
    name: "the first is cancelled",
    release: async (w) => w.send(ipcChannels.cancelTask, { taskId: "t1" }),
  },
  {
    name: "the first is answered and then cancelled",
    release: async (w) => {
      await answerFirst(w);
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
    },
  },
];

describe("a second question", () => {
  it.each(releaseRows)(
    "stays hidden, then shows and is said as given after $name",
    async ({ release }) => {
      const w = wire();
      await askClarify(w);
      await askClarify(w);
      expect(w.card("t2")?.question).toBeNull();
      // Only the front call's own line so far; main says the question once it shows.
      await flush();
      await w.playAll();
      const before = synthesized(w, "Which one for t2?");
      expect(before).toBe(1);
      await release(w);
      expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t2" });
      await flush();
      await w.playAll();
      expect(synthesized(w, "Which one for t2?")).toBe(before + 1);
    },
  );

  it("lets words that do not answer go through as a new task while the question stays shown", async () => {
    const w = wire();
    await askClarify(w);
    await answerWith(w, "something else", workRoute("rust"));
    expect(w.card("t2")?.state).toBe("running");
    expect(w.wiring.state.waitingQuestion()).toMatchObject({ taskId: "t1" });
  });
});

describe("a spoken answer routed as no task", () => {
  it("ends the waiting task done with the line when the answer is chat, starting no worker", async () => {
    const w = wire();
    await askClarify(w);
    await answerWith(
      w,
      "the first one",
      { ...replyRoute(), answerTo: "t1:question" },
      "That works.",
    );
    expect(w.card("t1")).toMatchObject({
      state: "done",
      reply: "That works.",
      answer: { cardText: "That works." },
      question: null,
    });
    expect(w.port.sent).toEqual([]);
    await flush();
    await w.playAll();
    expect(w.spoken()).toEqual(["Which one for t1?", "That works."]);
  });
});

describe("a spoken answer", () => {
  it.each([
    { admitted: 0, state: "running" },
    { admitted: 4, state: "cancelled" },
  ])(
    "removes the thinking card and routes the waiting task with $admitted tasks admitted",
    async ({ admitted, state }) => {
      const w = wire();
      await askClarify(w, "find me a laptop");
      for (let i = 0; i < admitted; i += 1) await admitAs(w, `task ${i}`);
      const temp = await answerWith(
        w,
        "the second one",
        workRoute("gaming laptops", "t1:question"),
      );
      expect(w.card(temp)).toBeUndefined();
      expect(w.card("t1")).toMatchObject({ state, question: null });
      if (admitted === 0) {
        expect(w.port.sent.at(-1)).toMatchObject({
          type: "runTask",
          taskId: "t1",
          ask: {
            userWords:
              'find me a laptop\nAnswer to "Which one for t1?": the second one',
          },
        });
      }
    },
  );
});

describe("spoken answers that compete or are cancelled", () => {
  it("drops a second spoken answer to the same question and starts nothing for it", async () => {
    const w = wire();
    await askClarify(w);
    ask(w, "the first one");
    ask(w, "the second one");
    await streamFront(
      w,
      { ...replyRoute(), answerTo: "t1:question" },
      "First wins.",
      1,
    );
    await streamFront(w, workRoute("x", "t1:question"), "Okay.", 2);
    expect(w.card("t3")).toBeUndefined();
    expect(w.card("t1")).toMatchObject({ state: "done", reply: "First wins." });
    expect(w.port.sent).toEqual([]);
  });

  it("starts nothing and keeps the question unclaimed when the answer is cancelled during its call", async () => {
    const w = wire();
    await askClarify(w);
    ask(w, "the second one");
    w.send(ipcChannels.cancelTask, { taskId: "t2" });
    w.wiring.state.talkerReplied("t2", "t2#1", {
      kind: "said",
      text: "ok",
      decision: workRoute("x", "t1:question"),
    });
    expect(w.card("t2")?.state).toBe("cancelled");
    expect(w.card("t1")).toMatchObject({
      state: "clarifying",
      question: { answered: false },
    });
    expect(w.port.sent).toEqual([]);
  });
});

describe("a clarifying task answered end to end", () => {
  it("continues to done in one front call when answered by typed words", async () => {
    const w = wire();
    await askClarify(w);
    await answerWith(
      w,
      "the cheaper one",
      workRoute("about it", "t1:question"),
      "Checking.",
    );
    // One call for the question and one for the answer; the engine is never asked to route.
    expect(w.talkerCalls).toHaveLength(2);
    expect(JSON.stringify(w.talkerCalls[1].request.messages)).toContain(
      "the cheaper one",
    );
    expect(w.card("t1")?.state).toBe("running");
    expect(w.port.sent.map((command) => command.type)).toEqual(["runTask"]);
    expect(w.port.sent[0]).toMatchObject({
      taskId: "t1",
      ask: { userWords: expect.stringContaining("the cheaper one") },
    });
    w.port.emit({
      type: "result",
      taskId: "t1",
      spokenLine: "The answer. spoken",
      findings: findings("The answer."),
    });
    expect(w.published.at(-1)?.tasks).toEqual([
      expect.objectContaining({
        taskId: "t1",
        state: "done",
        answer: expect.objectContaining({ cardText: "The answer." }),
      }),
    ]);
  });
});
