import { describe, expect, it } from "vitest";
import { createHarness, flush, userText } from "./talker.harness";
import type { TalkRequest } from "./tasks/talk";

const reply: TalkRequest = {
  kind: "reply",
  taskId: "t2",
  utteranceId: null,
  words: "will it rain in Delhi tomorrow?",
  recent: [
    {
      taskId: "t0",
      state: "done",
      question: "hi",
      answer: "Hello!",
      cardText: null,
    },
  ],
  tasks: [
    {
      taskId: "t1",
      state: "running",
      words: "how does hermes work",
      sayBack: "how Hermes works",
    },
  ],
  waiting: null,
};

describe("the talker's reply (L12)", () => {
  it("asks Haiku 5.5 with a 256-token ceiling and the words, the recent answers and the running tasks", () => {
    const h = createHarness();
    h.talker.talk(reply);
    const [{ request }] = h.calls;
    expect(request).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 256,
      thinking: { type: "disabled" },
    });
    expect(request.system).toContain("never claim progress");
    const text = userText(request);
    expect(text).toContain(
      "<words>\nwill it rain in Delhi tomorrow?\n</words>",
    );
    expect(text).toContain("- question: hi | answer: Hello!");
    expect(text).toContain("- running: how Hermes works");
    expect(text).toContain("<waiting_question>\nnone\n</waiting_question>");
  });

  it("streams its text into one talk line as it arrives and reports the whole line", async () => {
    const h = createHarness();
    h.talker.talk(reply);
    expect(h.lines).toEqual([{ taskId: "t2", kind: "talk", parts: [] }]);
    h.calls[0].onText("I'll check ");
    h.calls[0].onText("the forecast.");
    expect(h.lines[0].parts).toEqual(["I'll check ", "the forecast."]);
    h.calls[0].resolve({ ok: true, text: "I'll check the forecast." });
    await flush();
    expect(h.lines[0].parts.at(-1)).toBe("<end>");
    expect(h.replies).toEqual([
      {
        taskId: "t2",
        reply: { kind: "said", text: "I'll check the forecast." },
      },
    ]);
  });
});

describe("a failing talker reply", () => {
  it.each([
    ["a rejected key", "keyRejected", "keyRejected"],
    ["no credit", "noCredit", "noCredit"],
    ["an unreachable model", "unreachable", "modelsUnreachable"],
    ["an error", "error", "error"],
  ] as const)(
    "logs %s and reports it, never throwing",
    async (_name, failure, kind) => {
      const h = createHarness();
      h.talker.talk(reply);
      h.calls[0].resolve({ ok: false, failure, detail: "x" });
      await flush();
      expect(h.lines[0].parts).toEqual(["<end>"]);
      expect(h.replies).toEqual([
        { taskId: "t2", reply: { kind: "failed", failure: kind } },
      ]);
      expect(h.logs).toEqual(["talker reply failed: x"]);
    },
  );

  it("fails as a rejected key without an Anthropic key", async () => {
    const h = createHarness({ noKey: true });
    h.talker.talk(reply);
    await flush();
    expect(h.replies).toEqual([
      { taskId: "t2", reply: { kind: "failed", failure: "keyRejected" } },
    ]);
  });
});
