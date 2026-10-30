import { describe, expect, it } from "vitest";
import type { TaskCard, TaskState } from "../../../src/shared/cards";
import { orderCards } from "../../../src/renderer/cards/list";

type Card = Pick<TaskCard, "state" | "finishOrder"> & { id: string };

const card = (id: string, state: TaskState, finishOrder?: number): Card => ({
  id,
  state,
  finishOrder: finishOrder ?? null,
});

describe("orderCards", () => {
  it.each<{ name: string; tasks: Card[]; order: string[] }>([
    {
      name: "work in flight first in main's order, then finished tasks",
      tasks: [
        card("result", "done", 1),
        card("run", "running"),
        card("wait", "queued"),
        card("stopping", "cancelling"),
      ],
      order: ["run", "wait", "stopping", "result"],
    },
    {
      name: "finished tasks newest first, a failed or cancelled one among them",
      tasks: [
        card("first", "done", 1),
        card("second", "failed", 2),
        card("third", "cancelled", 3),
      ],
      order: ["third", "second", "first"],
    },
    {
      name: "an older task that finished after a newer one because it was retried sorts first",
      tasks: [card("older", "done", 3), card("newer", "done", 2)],
      order: ["older", "newer"],
    },
  ])("$name", ({ tasks, order }) => {
    expect(orderCards(tasks).map((task) => task.id)).toEqual(order);
  });
});
