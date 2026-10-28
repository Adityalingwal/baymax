import type { Model, Change, TaskRecord } from "./record";
import { say } from "./record";

export function shownQuestion(model: Model): TaskRecord | null {
  for (const record of model.records.values()) {
    if (record.card.question?.answered === false) return record;
  }
  return null;
}

// Runs after every accepted change, so a hidden question shows whatever made the shown one go; it is said as given.
export function showNextQuestion(change: Change): void {
  const { model } = change;
  if (shownQuestion(model) !== null) return;
  for (const taskId of [...model.questions]) {
    model.questions = model.questions.filter((id) => id !== taskId);
    const record = model.records.get(taskId);
    const question = record?.hiddenQuestion ?? null;
    if (record?.card.state !== "clarifying" || question === null) continue;
    record.card.question = { ...question, answered: false };
    record.hiddenQuestion = null;
    say(change, taskId, question.text, "question");
    return;
  }
}
