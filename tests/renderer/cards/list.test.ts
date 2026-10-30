import { describe, expect, it } from "vitest";
import type { TaskCard, TaskState } from "../../../src/shared/cards";
import { isPending } from "../../../src/renderer/cards/forms";
import { orderCards } from "../../../src/renderer/cards/list";

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
