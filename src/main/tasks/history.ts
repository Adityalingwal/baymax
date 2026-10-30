import type { TaskCard, TaskId } from "../../shared/cards";
import type { HistoryTurn } from "./talk";

// One front call that said something: the user's words and the line Baymax said, kept apart from the cards.
export type Exchange = {
  order: number; // when its front call started, so a slower call cannot reorder the conversation; a later line moves it up
  taskId: TaskId;
  words: string;
  line: string;
  later: string[]; // what Baymax said about the task afterwards, in order: its failure line, its result
};

// Where the conversation is kept; the order counter is shared with the front calls.
type ExchangeLog = { exchanges: Exchange[]; exchangeOrder: number };

const WINDOW = 20;
const KEEP = 30;

export function addExchange(
  exchanges: Exchange[],
  entry: { order: number; taskId: TaskId; words: string; line: string },
  keep: (taskId: TaskId) => boolean,
): void {
  if (entry.line.trim() === "") return;
  exchanges.push({ ...entry, later: [] });
  exchanges.sort((a, b) => a.order - b.order);
  let over = exchanges.length - KEEP;
  for (let index = 0; over > 0 && index < exchanges.length;) {
    if (keep(exchanges[index].taskId)) {
      index += 1;
    } else {
      exchanges.splice(index, 1);
      over -= 1;
    }
  }
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

// A line with no words of its own joins the task's latest exchange, so no empty user turn enters history.
// It was just said, so the exchange moves to the newest place; one that aged out comes back with the task's words.
export function appendLine(
  log: ExchangeLog,
  { taskId, words }: Pick<TaskCard, "taskId" | "words">,
  line: string,
): void {
  if (line.trim() === "") return;
  log.exchangeOrder += 1;
  const order = log.exchangeOrder;
  const exchange = log.exchanges
    .filter((other) => other.taskId === taskId)
    .at(-1);
  if (exchange === undefined) {
    log.exchanges.push({ order, taskId, words, line, later: [] });
  } else {
    exchange.later.push(line);
    exchange.order = order;
  }
  log.exchanges.sort((a, b) => a.order - b.order);
}

// The last exchanges as alternating user and assistant turns, oldest first.
export function conversationHistory(exchanges: Exchange[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const said = exchanges.filter((exchange) => exchange.line.trim() !== "");
  for (const exchange of said.slice(-WINDOW)) {
    const spoken = [exchange.line, ...exchange.later].join("\n");
    turns.push(
      { role: "user", text: exchange.words },
      { role: "assistant", text: spoken },
    );
  }
  return turns;
}
