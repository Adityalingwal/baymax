import { describe, expect, it } from "vitest";
import type { TaskCard, TaskState } from "../../../src/shared/cards";
import { isPending } from "../../../src/renderer/cards/forms";
import { orderCards, statusLine } from "../../../src/renderer/cards/list";

type Card = Pick<TaskCard, "state"> & { id: string };

const card = (id: string, state: TaskState): Card => ({ id, state });

const result = card("result", "done");

describe("isPending", () => {
  it.each<[TaskState, boolean, boolean]>([
    ["queued", false, true],
    ["queued", true, false],
    ["running", false, true],
    ["cancelling", false, false],
    ["done", false, false],
  ])("%s with Retry %s: %s", (state, canRetry, pending) => {
    expect(isPending({ state, canRetry })).toBe(pending);
  });
});

describe("orderCards", () => {
  it("puts work in flight first, then results, keeping main's order", () => {
    const tasks = [
      result,
      card("run", "running"),
      card("wait", "queued"),
      card("gone", "cancelled"),
    ];
    expect(orderCards(tasks).map((task) => task.id)).toEqual([
      "run",
      "wait",
      "result",
      "gone",
    ]);
  });
});

describe("statusLine", () => {
  it.each<{ name: string; tasks: Card[]; line: string }>([
    { name: "no tasks", tasks: [], line: "Nothing running" },
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
      name: "results only, failed cards not counted",
      tasks: [result, { ...result, id: "r2" }, card("i", "failed")],
      line: "2 results",
    },
    {
      name: "one result",
      tasks: [result],
      line: "1 result",
    },
    {
      name: "only a failed card",
      tasks: [card("i", "failed")],
      line: "Nothing running",
    },
  ])("$name: $line", ({ tasks, line }) => {
    expect(statusLine(tasks)).toBe(line);
  });
});
