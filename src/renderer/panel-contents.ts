import type {
  ChatEntry,
  DisplayState,
  TaskCard,
  TaskId,
} from "../shared/cards";
import { shownReport } from "./cards/forms";
import { orderCards } from "./cards/list";

// What the open panel shows. Rules: design-lock-panel-contents.md.
export type PanelTab = "chat" | "tasks";

// reportOf: the task whose report page replaces the Tasks list.
export type PanelView = { tab: PanelTab; reportOf: TaskId | null };

export type PanelViewEvent =
  | { kind: "tab"; tab: PanelTab }
  | { kind: "open-report"; taskId: TaskId }
  | { kind: "back" }
  | { kind: "open-result" };

// Kept while the panel is closed, so it opens on the tab last open.
export const initialView: PanelView = { tab: "tasks", reportOf: null };

export function viewReducer(view: PanelView, event: PanelViewEvent): PanelView {
  switch (event.kind) {
    case "tab":
      return { ...view, tab: event.tab };
    case "open-report":
      return { tab: "tasks", reportOf: event.taskId };
    case "back":
      return { ...view, reportOf: null };
    // A click on the answer island always opens the Tasks list, at that card.
    case "open-result":
      return { tab: "tasks", reportOf: null };
  }
}

export type ChatRow = {
  id: string;
  side: "left" | "right"; // your words on the left, Baymax's on the right
  text: string;
  time: string;
};

function chatRows(chat: readonly ChatEntry[]): ChatRow[] {
  return chat.map(({ id, from, text, at }) => ({
    id,
    side: from === "user" ? "left" : "right",
    text,
    time: new Date(at).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    }),
  }));
}

export type PanelContent =
  | { kind: "chat"; rows: ChatRow[] }
  | { kind: "tasks"; cards: TaskCard[] }
  | { kind: "report"; card: TaskCard; report: string };

// A report page whose task or report is gone falls back to the list.
export function panelContent(
  view: PanelView,
  { chat, tasks }: Pick<DisplayState, "chat" | "tasks">,
): PanelContent {
  if (view.tab === "chat") return { kind: "chat", rows: chatRows(chat) };
  const card = tasks.find(({ taskId }) => taskId === view.reportOf);
  const report = card === undefined ? null : shownReport(card);
  return card === undefined || report === null
    ? { kind: "tasks", cards: orderCards(tasks) }
    : { kind: "report", card, report };
}
