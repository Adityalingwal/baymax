import { describe, expect, it } from "vitest";
import {
  createHarness,
  finished,
  flush,
  frontRequest,
  lastUserText,
} from "./talker.harness";

const decide = (input: unknown) => ({ name: "decide", input });

const turns = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "Hello!" },
] as const;

describe("the front call's request", () => {
  it("asks Fable 5.1 at low effort with the decide tool, no thinking and no tool choice", () => {
    const h = createHarness();
    h.talker.talk(frontRequest({ history: [...turns] }));
    const [{ request }] = h.calls;
    expect(request).toMatchObject({
      model: "claude-fable-5-1",
      max_tokens: 2048,
      output_config: { effort: "low" },
      tools: [{ name: "decide" }],
    });
    expect(request.thinking).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.system).toContain("Then call the decide tool once");
  });

  it("sends the history as real turns before the current one, with the cache mark on the last history turn", () => {
    const h = createHarness();
    h.talker.talk(frontRequest({ history: [...turns] }));
    const { messages } = h.calls[0].request;
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello!",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { role: "user", content: expect.stringContaining("<words>") },
    ]);
  });

  it("sends only the current turn, with no cache mark, when there is no history", () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    expect(h.calls[0].request.messages).toHaveLength(1);
    expect(JSON.stringify(h.calls[0].request)).not.toContain("cache_control");
  });
});

describe("the front call's data blocks", () => {
  it("carries every id and card fact the instructions refer to", () => {
    const h = createHarness();
    h.talker.talk(
      frontRequest({
        recent: [
          {
            taskId: "t0",
            state: "done",
            question: "headphones under 30k",
            answer: "Three picks.",
            cardText: "Sennheiser 24,990 | Sony 26,990",
          },
        ],
        tasks: [
          { taskId: "t1", state: "running", words: "hermes", topic: "Hermes" },
        ],
        waiting: {
          taskId: "t3",
          words: "find me a laptop",
          question: {
            questionId: "t3:question",
            text: "For what use?",
            choices: ["Office", "Gaming"],
          },
        },
      }),
    );
    const text = lastUserText(h.calls[0].request);
    for (const fact of [
      "<words>\nwill it rain in Delhi tomorrow?\n</words>",
      "task t0 (done): question: headphones under 30k | answer: Three picks.",
      "card: Sennheiser 24,990 | Sony 26,990",
      "task t1 (running): hermes | topic: Hermes",
      "task id: t3",
      "question id: t3:question",
      "request: find me a laptop",
      "question: For what use?",
      "- Office",
      "- Gaming",
    ]) {
      expect(text).toContain(fact);
    }
    h.talker.talk(frontRequest({ attemptId: "t4#1", taskId: "t4" }));
    expect(lastUserText(h.calls[1].request)).toContain(
      "<waiting_question>\nnone\n</waiting_question>",
    );
  });
});

describe("the front call's line and decision", () => {
  it("streams the line into speech, ends it when the tool starts, and drops text after it", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    expect(h.lines).toEqual([{ taskId: "t2", kind: "talk", parts: [] }]);
    h.calls[0].onText("I'll check ");
    h.calls[0].onText("the forecast.");
    expect(h.lines[0].parts).toEqual(["I'll check ", "the forecast."]);
    h.calls[0].onToolStart();
    expect(h.lines[0].parts.at(-1)).toBe("<end>");
    h.calls[0].onText("Anything else?");
    const input = { route: "newTask" };
    h.calls[0].resolve(finished("I'll check the forecast.", [decide(input)]));
    await flush();
    expect(h.lines[0].parts).toEqual(["I'll check ", "the forecast.", "<end>"]);
    expect(h.replies).toEqual([
      {
        taskId: "t2",
        attemptId: "t2#1",
        reply: {
          kind: "said",
          text: "I'll check the forecast.",
          decision: input,
        },
      },
    ]);
    expect(h.logs).toEqual([
      "talker front call done (in 10, out 5, cache read 7)",
    ]);
  });

  it("hands main a null decision when no tool came", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].resolve(finished("It's 4.", [], "end_turn"));
    await flush();
    expect(h.lines[0].parts).toEqual(["<end>"]);
    expect(h.replies[0].reply).toEqual({
      kind: "said",
      text: "It's 4.",
      decision: null,
    });
  });
});

describe("a failing front call", () => {
  const input = { route: "chat" };
  it.each([
    [
      "a rejected key",
      { ok: false, failure: "keyRejected", detail: "x" },
      "keyRejected",
    ],
    ["no credit", { ok: false, failure: "noCredit", detail: "x" }, "noCredit"],
    [
      "an unreachable model",
      { ok: false, failure: "unreachable", detail: "x" },
      "modelsUnreachable",
    ],
    ["an error", { ok: false, failure: "error", detail: "x" }, "error"],
    ["no text", finished("  ", [decide(input)]), "error"],
    [
      "a truncated reply",
      finished("Hi", [decide(input)], "max_tokens"),
      "error",
    ],
    ["a refusal", finished("No.", [], "refusal"), "error"],
    ["two tools", finished("Hi", [decide(input), decide(input)]), "error"],
    ["another tool", finished("Hi", [{ name: "search", input }]), "error"],
    [
      "a tool without the tool stop",
      finished("Hi", [decide(input)], "end_turn"),
      "error",
    ],
  ] as const)(
    "reports %s as %s, never throwing",
    async (_name, outcome, kind) => {
      const h = createHarness();
      h.talker.talk(frontRequest());
      h.calls[0].resolve(outcome);
      await flush();
      expect(h.lines[0].parts).toEqual(["<end>"]);
      expect(h.replies).toEqual([
        {
          taskId: "t2",
          attemptId: "t2#1",
          reply: { kind: "failed", failure: kind },
        },
      ]);
      expect(h.logs[0]).toContain("talker front call failed");
    },
  );
});

describe("a front call without a key", () => {
  it("fails as a rejected key without an Anthropic key", async () => {
    const h = createHarness({ noKey: true });
    h.talker.talk(frontRequest());
    await flush();
    expect(h.replies[0].reply).toEqual({
      kind: "failed",
      failure: "keyRejected",
    });
  });
});

describe("the 10 s deadline", () => {
  it("aborts a stream that sent headers and then stalled, cuts its speech and reports it once", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].onText("I'll ");
    h.advance(9_999);
    expect(h.replies).toEqual([]);
    h.advance(1);
    await flush();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.lines[0].parts).toEqual(["I'll ", "<cut>"]);
    expect(h.replies).toEqual([
      {
        taskId: "t2",
        attemptId: "t2#1",
        reply: { kind: "failed", failure: "modelsUnreachable" },
      },
    ]);
    // A late completion after the deadline changes nothing.
    h.calls[0].resolve(finished("I'll check.", [decide({ route: "chat" })]));
    await flush();
    expect(h.replies).toHaveLength(1);
  });

  it("cancels the deadline when the call finishes in time", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].resolve(finished("Hi.", [decide({ route: "chat" })]));
    await flush();
    h.advance(20_000);
    await flush();
    expect(h.replies).toHaveLength(1);
    expect(h.calls[0].signal.aborted).toBe(false);
  });
});

describe("cancelling an attempt", () => {
  it("before any text: aborts the call, cuts the line and reports nothing", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.talker.cancel("t2#1");
    await flush();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.lines[0].parts).toEqual(["<cut>"]);
    expect(h.replies).toEqual([]);
  });

  it("after text: cuts the spoken line, and a late success or failure changes nothing", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].onText("I'll check");
    h.talker.cancel("t2#1");
    h.calls[0].onText(" more");
    h.calls[0].resolve(finished("I'll check", [decide({ route: "chat" })]));
    await flush();
    h.talker.talk(frontRequest({ attemptId: "t2#2" }));
    h.talker.cancel("t2#2");
    h.calls[1].resolve({ ok: false, failure: "error", detail: "late" });
    await flush();
    expect(h.lines[0].parts).toEqual(["I'll check", "<cut>"]);
    expect(h.replies).toEqual([]);
    h.advance(20_000);
    expect(h.replies).toEqual([]);
  });

  it("shutdown cancels every attempt", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.talker.talk(frontRequest({ attemptId: "t5#1", taskId: "t5" }));
    h.talker.shutdown();
    h.calls[0].resolve(finished("Hi.", [decide({ route: "chat" })]));
    await flush();
    expect(h.calls.map((call) => call.signal.aborted)).toEqual([true, true]);
    expect(h.lines.map((line) => line.parts)).toEqual([["<cut>"], ["<cut>"]]);
    expect(h.replies).toEqual([]);
  });
});
