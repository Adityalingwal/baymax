import { describe, expect, it } from "vitest";
import { addExchange, appendResult, conversationHistory } from "./history";
import type { Exchange } from "./history";

const add = (exchanges: Exchange[], taskId: string, n: number) =>
  addExchange(exchanges, {
    order: n,
    taskId,
    words: `words ${n}`,
    line: `line ${n}`,
  });

describe("the conversation history", () => {
  it("alternates the user's words and what Baymax said, oldest first", () => {
    const exchanges: Exchange[] = [];
    add(exchanges, "t1", 1);
    add(exchanges, "t2", 2);
    expect(conversationHistory(exchanges)).toEqual([
      { role: "user", text: "words 1" },
      { role: "assistant", text: "line 1" },
      { role: "user", text: "words 2" },
      { role: "assistant", text: "line 2" },
    ]);
  });

  it("orders by when the call started, not by when its exchange was added", () => {
    const exchanges: Exchange[] = [];
    add(exchanges, "t2", 2);
    add(exchanges, "t1", 1);
    expect(conversationHistory(exchanges).map((turn) => turn.text)).toEqual([
      "words 1",
      "line 1",
      "words 2",
      "line 2",
    ]);
  });

  it("keeps the last 10 exchanges", () => {
    const exchanges: Exchange[] = [];
    for (let n = 1; n <= 25; n += 1) add(exchanges, `t${n}`, n);
    const turns = conversationHistory(exchanges);
    expect(turns).toHaveLength(20);
    expect(turns[0]).toEqual({ role: "user", text: "words 16" });
    expect(turns.at(-1)).toEqual({ role: "assistant", text: "line 25" });
  });

  it("skips an exchange with nothing said", () => {
    const exchanges: Exchange[] = [];
    addExchange(exchanges, { order: 1, taskId: "t1", words: "hi", line: "  " });
    add(exchanges, "t2", 2);
    expect(conversationHistory(exchanges)).toHaveLength(2);
  });
});

describe("the results in the conversation history", () => {
  it("adds a done task's result line to its exchange once, on its own line", () => {
    const exchanges: Exchange[] = [];
    add(exchanges, "t1", 1);
    add(exchanges, "t2", 2);
    appendResult(exchanges, "t1", "It will rain.");
    appendResult(exchanges, "t1", "Again.");
    appendResult(exchanges, "t9", "Nobody's.");
    expect(conversationHistory(exchanges)[1]).toEqual({
      role: "assistant",
      text: "line 1\nIt will rain.",
    });
    expect(conversationHistory(exchanges)[3].text).toBe("line 2");
  });

  it("adds a result to the latest exchange of the task", () => {
    const exchanges: Exchange[] = [];
    add(exchanges, "t1", 1);
    add(exchanges, "t1", 2);
    appendResult(exchanges, "t1", "Done.");
    expect(exchanges.map((exchange) => exchange.result)).toEqual([
      null,
      "Done.",
    ]);
  });
});
