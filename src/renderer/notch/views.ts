import type { TaskCard } from "../../shared/cards";
import type { VoicePhase } from "../../shared/ipc";
import { isRunning } from "../cards/list";

// What the notch shows with the panel closed. Sizes and rules: notch-design-locked.md,
// "Running task: spinning ring", "Voice pill", "Task finish" and "Answer island grow".
export type ClosedView = "notch" | "ring" | "pill" | "island";

type ViewInput = {
  island: boolean; // a done task's answer is speaking and was not opened in the panel
  pill: boolean; // the voice pill is shown
  running: number; // tasks running or waiting their turn
};

// The answer island wins over the pill, the pill over the running ring.
export function closedView({ island, pill, running }: ViewInput): ClosedView {
  if (island) return "island";
  if (pill) return "pill";
  return running > 0 ? "ring" : "notch";
}

export function runningCount(tasks: readonly Pick<TaskCard, "state">[]) {
  return tasks.filter((card) => isRunning(card.state)).length;
}

// Only a done task's own result line grows into the island; a chat reply, a failed line, a question or a notice uses the pill.
export function isAnswerLine(
  phase: VoicePhase,
  tasks: readonly Pick<TaskCard, "taskId" | "state">[],
): boolean {
  if (phase.phase !== "speaking") return false;
  const { kind, taskId } = phase.line;
  if (kind !== "answer" || taskId === null) return false;
  const card = tasks.find((task) => task.taskId === taskId);
  return card !== undefined && card.state === "done";
}

export const islandLayout = {
  width: 480,
  maxLines: 3,
  strip: 32,
  gap: 4, // between the strip and the card, as in the selected preview
  side: 10,
  bottom: 10,
  lineHeight: 19, // the spoken line's line height
} as const;

// Up to three lines at 480 pt; a fourth widens the island to the panel's width instead of cutting the text.
export function islandWidth(linesAt480: number, wide: number): number {
  return linesAt480 <= islandLayout.maxLines ? islandLayout.width : wide;
}
