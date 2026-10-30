import type { TaskCard, TaskState } from "../../shared/cards";

type ListCard = Pick<TaskCard, "state">;

// Work in flight, then results.
function rank(state: TaskState): number {
  return state === "done" || state === "failed" || state === "cancelled"
    ? 1
    : 0;
}

// Stable within a group, so main's order holds.
export function orderCards<C extends ListCard>(tasks: readonly C[]): C[] {
  return tasks
    .map((card, index) => ({ card, index }))
    .sort(
      (a, b) => rank(a.card.state) - rank(b.card.state) || a.index - b.index,
    )
    .map(({ card }) => card);
}

// A task counts as running while it runs or waits its turn; the notch ring uses the same rule.
export function isRunning(state: TaskState): boolean {
  return state === "running" || state === "queued";
}

// The top strip's status: what runs; results only when nothing runs.
export function statusLine(tasks: readonly ListCard[]): string {
  const running = tasks.filter((card) => isRunning(card.state)).length;
  const results = tasks.filter((card) => card.state === "done").length;
  if (running > 0) return `${running} running`;
  if (results === 0) return "Nothing running";
  return results === 1 ? "1 result" : `${results} results`;
}
