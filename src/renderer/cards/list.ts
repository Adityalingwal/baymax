import type { TaskCard, TaskState } from "../../shared/cards";
import { isChatReply } from "./forms";

type ListCard = Pick<TaskCard, "state" | "reply" | "answer">;

// One list for the demo (tabs come later): cards that need you, then work in flight, then results.
function rank(state: TaskState): number {
  if (state === "clarifying") return 0;
  if (state === "done" || state === "incomplete" || state === "cancelled") {
    return 2;
  }
  return 1;
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

// The top strip's status: what needs you and what runs; results only when nothing else does. Chat replies are not tasks.
export function statusLine(tasks: readonly ListCard[]): string {
  const needsYou = tasks.filter((card) => card.state === "clarifying").length;
  const running = tasks.filter((card) => isRunning(card.state)).length;
  const done = tasks.filter(
    (card) =>
      (card.state === "done" || card.state === "incomplete") &&
      !isChatReply(card),
  ).length;
  const parts = [
    needsYou > 0 ? `${needsYou} needs you` : null,
    running > 0 ? `${running} running` : null,
  ].filter((part) => part !== null);
  if (parts.length > 0) return parts.join(" · ");
  return done > 0 ? `${done} done` : "Nothing running";
}
