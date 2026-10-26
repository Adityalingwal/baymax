import type { DisplayState, TaskCard, TaskId } from "../../shared/cards";
import type { RecentExchange, WaitingQuestion } from "../../shared/engine";
import type { Model } from "./record";
import { shownQuestion } from "./record";

const RECENT_COUNT = 5;

// A deep copy, so a changed snapshot never reaches the model or the source allowlist.
function copyCard(card: TaskCard): TaskCard {
  return structuredClone(card);
}

export function buildDisplay(model: Model): DisplayState {
  const tasks: TaskCard[] = [];
  for (const record of model.records.values()) {
    if (record.shown) tasks.push(copyCard(record.card));
  }
  return {
    tasks,
    notice: model.notice,
    muted: model.muted,
    voiceAvailable: model.voiceAvailable,
  };
}

export function recentExchanges(
  model: Model,
  forTaskId: TaskId,
): RecentExchange[] {
  return [...model.records.values()]
    .filter((record) => record.card.taskId !== forTaskId)
    .slice(-RECENT_COUNT)
    .map(({ card, spokenLine }) => ({
      taskId: card.taskId,
      state: card.state,
      question: card.words,
      answer: card.state === "done" ? spokenLine : null,
    }));
}

export function waitingQuestion(model: Model): WaitingQuestion | null {
  const record = shownQuestion(model);
  const question = record?.card.question ?? null;
  if (record === null || question === null) return null;
  const { questionId, text, choices } = question;
  return {
    taskId: record.card.taskId,
    question: { questionId, text, choices: [...choices] },
  };
}
