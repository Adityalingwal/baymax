import type { TaskId } from "../../shared/cards";
import type { HistoryTurn } from "./talk";

// One front call that said something: the user's words and the line Baymax said, kept apart from the cards.
export type Exchange = {
  order: number; // when its front call started, so a slower call cannot reorder the conversation
  taskId: TaskId;
  words: string;
  line: string;
  result: string | null; // the spoken line of the task's result, once it ended done
};

const WINDOW = 20;
const KEEP = 30;

export function addExchange(
  exchanges: Exchange[],
  entry: { order: number; taskId: TaskId; words: string; line: string },
): void {
  if (entry.line.trim() === "") return;
  exchanges.push({ ...entry, result: null });
  exchanges.sort((a, b) => a.order - b.order);
  if (exchanges.length > KEEP) exchanges.splice(0, exchanges.length - KEEP);
}

// An answer's exchange moves to the waiting task it answered, so that task's result joins it.
export function setExchangeTask(
  exchanges: Exchange[],
  order: number,
  taskId: TaskId,
): void {
  const exchange = exchanges.find((other) => other.order === order);
  if (exchange !== undefined) exchange.taskId = taskId;
}

// A task that ended done adds its result line to its latest exchange, once.
export function appendResult(
  exchanges: Exchange[],
  taskId: TaskId,
  line: string,
): void {
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = exchanges[index];
    if (exchange.taskId !== taskId) continue;
    if (exchange.result === null) exchange.result = line;
    return;
  }
}

// The last exchanges as alternating user and assistant turns, oldest first.
export function conversationHistory(exchanges: Exchange[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const said = exchanges.filter((exchange) => exchange.line.trim() !== "");
  for (const exchange of said.slice(-WINDOW)) {
    const spoken =
      exchange.result === null
        ? exchange.line
        : `${exchange.line}\n${exchange.result}`;
    turns.push(
      { role: "user", text: exchange.words },
      { role: "assistant", text: spoken },
    );
  }
  return turns;
}
