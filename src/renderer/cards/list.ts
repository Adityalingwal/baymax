import type { TaskCard, TaskState } from "../../shared/cards";

type ListCard = Pick<TaskCard, "state" | "finishOrder">;

function isFinished({ state }: ListCard): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

// Work in flight in main's order, then finished tasks, the last to finish first.
export function orderCards<C extends ListCard>(tasks: readonly C[]): C[] {
  const finished = tasks
    .filter(isFinished)
    .sort((a, b) => (b.finishOrder ?? 0) - (a.finishOrder ?? 0));
  return [...tasks.filter((card) => !isFinished(card)), ...finished];
}

// A task counts as running while it runs or waits its turn; the notch ring uses the same rule.
export function isRunning(state: TaskState): boolean {
  return state === "running" || state === "queued";
}
