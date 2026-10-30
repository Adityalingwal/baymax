// What the open panel shows. Rules: design-lock-panel-contents.md.
export type PanelTab = "chat" | "tasks";

export type PanelView = { tab: PanelTab };

export type PanelViewEvent =
  { kind: "tab"; tab: PanelTab } | { kind: "open-result" };

// Kept while the panel is closed, so it opens on the tab last open.
export const initialView: PanelView = { tab: "tasks" };

export function viewReducer(view: PanelView, event: PanelViewEvent): PanelView {
  switch (event.kind) {
    case "tab":
      return { ...view, tab: event.tab };
    // A click on the answer island always opens Tasks.
    case "open-result":
      return { ...view, tab: "tasks" };
  }
}
