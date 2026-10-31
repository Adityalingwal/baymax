import type { DisplayState, TaskCard, TaskId } from "../../shared/cards";
import { fixedLines } from "./lines";
import type { Model, TaskRecord } from "./record";
import { activeQuestion } from "./record";
import type { RecentExchange, TaskSummary, WaitingQuestion } from "./talk";

const RUNNING_LIMIT = 1;
const QUEUE_LIMIT = 3;
const RECENT_COUNT = 5;
const CARD_COUNT = 2;
const CARD_LIMIT = 1500;

function cardExcerpt(cardText: string): string {
  if (cardText.length <= CARD_LIMIT) return cardText;
  const cut = cardText.slice(0, CARD_LIMIT - 1);
  // A cut inside a surrogate pair would leave half a character.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

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
    chat: structuredClone(model.chat),
    notice: model.notice,
    keyMissing: model.notice === fixedLines.keyMissing,
    muted: model.muted,
    voiceAvailable: model.voiceAvailable,
  };
}

export function recentExchanges(
  model: Model,
  forTaskId: TaskId,
): RecentExchange[] {
  const records = [...model.records.values()]
    .filter((record) => record.card.taskId !== forTaskId)
    .slice(-RECENT_COUNT);
  const carded = new Map<TaskId, string>();
  for (const { card } of records
    .filter((r) => (r.card.answer?.cardText ?? "") !== "")
    .slice(-CARD_COUNT)) {
    if (card.answer !== null) {
      carded.set(card.taskId, cardExcerpt(card.answer.cardText));
    }
  }
  return records.map(({ card, spokenLine }) => ({
    taskId: card.taskId,
    state: card.state,
    question: card.words,
    answer: card.state === "done" ? spokenLine : null,
    cardText: carded.get(card.taskId) ?? null,
  }));
}

export function waitingQuestion(model: Model): WaitingQuestion | null {
  const record = activeQuestion(model);
  const question = record?.question ?? null;
  if (record === null || question === null) return null;
  return {
    taskId: record.card.taskId,
    words: record.card.words,
    question: { ...question },
  };
}

const isRunningOrQueued = ({ card }: TaskRecord) =>
  card.state === "running" || card.state === "queued";

export function taskSummaries(model: Model): TaskSummary[] {
  return [...model.records.values()]
    .filter(isRunningOrQueued)
    .map(({ card, topic }) => ({
      taskId: card.taskId,
      state: card.state,
      words: card.words,
      topic,
    }));
}

// A cancelling task holds the slot until the engine replies; a race past the limit queues one extra, so the room left never goes below zero.
export function roomLeft(model: Model): number {
  const taken = [...model.records.values()].filter(
    ({ card, sent }) => card.state === "queued" || sent?.type === "runTask",
  ).length;
  return Math.max(0, RUNNING_LIMIT + QUEUE_LIMIT - taken);
}
