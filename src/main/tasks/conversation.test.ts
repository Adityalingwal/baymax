import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import { chat, createHarness } from "./harness";

describe("the conversation order", () => {
  it("keeps the conversation in the order the calls started when they finish in reverse", () => {
    const h = createHarness();
    h.state.ask("first question", null, null);
    h.state.ask("second question", null, null);
    h.reply("t2", chat(), "Second answer.");
    h.reply("t1", chat(), "First answer.");
    h.state.ask("third question", null, null);
    expect(h.talked.at(-1)?.history).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "First answer." },
      { role: "user", text: "second question" },
      { role: "assistant", text: "Second answer." },
    ]);
  });
});

describe("the conversation keeps what was spoken when the call fails", () => {
  it.each([
    {
      name: "a call with no tool",
      fail: (h: Harness) => h.reply("t1", null, "It's four."),
    },
    {
      name: "a decision that fails its check",
      fail: (h: Harness) => h.reply("t1", { route: "newTask" }, "It's four."),
    },
    {
      name: "a call that failed after speaking",
      fail: (h: Harness) =>
        h.state.talkerReplied("t1", "t1#1", {
          kind: "failed",
          failure: "error",
          text: "It's four.",
        }),
    },
  ])("$name leaves the line in the next request's history", ({ fail }) => {
    const h = createHarness();
    h.state.ask("what is 2 + 2?", null, null);
    fail(h);
    expect(h.card("t1")).toMatchObject({ canRetry: true });
    h.state.ask("what did you say?", null, null);
    expect(h.talked.at(-1)?.history).toEqual([
      { role: "user", text: "what is 2 + 2?" },
      { role: "assistant", text: "It's four." },
    ]);
  });

  it("makes a retry that speaks again its own exchange", () => {
    const h = createHarness();
    h.state.ask("what is 2 + 2?", null, null);
    h.reply("t1", null, "It's four.");
    h.state.retryTask("t1");
    h.reply("t1", chat(), "Four.");
    h.state.ask("again?", null, null);
    expect(h.talked.at(-1)?.history.map((turn) => turn.text)).toEqual([
      "what is 2 + 2?",
      "It's four.",
      "what is 2 + 2?",
      "Four.",
    ]);
  });
});
