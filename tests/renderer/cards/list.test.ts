import { describe, expect, it } from "vitest";
import type { Findings, TaskCard, TaskState } from "../../../src/shared/cards";
import { isChatReply, isPending } from "../../../src/renderer/cards/forms";
import { orderCards, statusLine } from "../../../src/renderer/cards/list";

type Card = Pick<TaskCard, "state" | "reply" | "answer" | "canRetry"> & {
  id: string;
};

const findings = (cardText: string, sources = 0): Findings => ({
  cardText,
  sources: Array.from({ length: sources }, (_, index) => ({
    id: `s${index}`,
    url: `https://example.com/${index}`,
    title: `Page ${index}`,
  })),
  openPoints: [],
});

const card = (id: string, state: TaskState, fields: Partial<Card> = {}) => ({
  id,
  state,
  reply: null,
  answer: null,
  canRetry: false,
  ...fields,
});

const chat = card("chat", "done", {
  reply: "Glad it helped.",
  answer: findings("Glad it helped."),
});
const result = card("result", "done", {
  reply: "I'll check.",
  answer: findings("Hermes runs a loop.", 2),
});

describe("isChatReply", () => {
  it.each([
    { name: "a done card whose answer is its reply", card: chat, chat: true },
    { name: "a research result", card: result, chat: false },
    {
      name: "a result with no sources that is not the reply",
      card: card("x", "done", {
        reply: "I'll check.",
        answer: findings("No pages."),
      }),
      chat: false,
    },
    {
      name: "an incomplete card",
      card: { ...chat, state: "incomplete" as const },
      chat: false,
    },
  ])("$name: $chat", ({ card: given, chat: expected }) => {
    expect(isChatReply(given)).toBe(expected);
  });
});

describe("isPending", () => {
  it.each<[TaskState, boolean, boolean]>([
    ["thinking", false, true],
    ["thinking", true, false],
    ["queued", false, true],
    ["running", false, true],
    ["clarifying", false, false],
    ["cancelling", false, false],
    ["done", false, false],
  ])("%s with Retry %s: %s", (state, canRetry, pending) => {
    expect(isPending({ state, canRetry })).toBe(pending);
  });
});

describe("orderCards", () => {
  it("puts cards that need you first, then work in flight, then results, keeping main's order", () => {
    const tasks = [
      result,
      card("run", "running"),
      card("ask", "clarifying"),
      chat,
      card("wait", "queued"),
      card("gone", "cancelled"),
    ];
    expect(orderCards(tasks).map((task) => task.id)).toEqual([
      "ask",
      "run",
      "wait",
      "result",
      "chat",
      "gone",
    ]);
  });
});

describe("statusLine", () => {
  it.each<{ name: string; tasks: Card[]; line: string }>([
    { name: "no tasks", tasks: [], line: "Nothing running" },
    { name: "only a chat reply", tasks: [chat], line: "Nothing running" },
    {
      name: "one running",
      tasks: [card("a", "running"), result],
      line: "1 running",
    },
    {
      name: "running and queued both run",
      tasks: [card("a", "running"), card("b", "queued")],
      line: "2 running",
    },
    {
      name: "a question and a running task",
      tasks: [card("a", "clarifying"), card("b", "running")],
      line: "1 needs you · 1 running",
    },
    {
      name: "results only, chat not counted",
      tasks: [result, { ...result, id: "r2" }, card("i", "incomplete"), chat],
      line: "3 done",
    },
  ])("$name: $line", ({ tasks, line }) => {
    expect(statusLine(tasks)).toBe(line);
  });
});
