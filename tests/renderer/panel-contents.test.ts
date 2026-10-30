import { describe, expect, it } from "vitest";
import { initialView, viewReducer } from "../../src/renderer/panel-contents";
import type {
  PanelTab,
  PanelViewEvent,
} from "../../src/renderer/panel-contents";

const toChat: PanelViewEvent = { kind: "tab", tab: "chat" };
const toTasks: PanelViewEvent = { kind: "tab", tab: "tasks" };
const islandClick: PanelViewEvent = { kind: "open-result" };

function run(events: PanelViewEvent[]) {
  return events.reduce(viewReducer, initialView);
}

describe("which tab opens", () => {
  it.each<{ name: string; events: PanelViewEvent[]; tab: PanelTab }>([
    { name: "the first time: Tasks", events: [], tab: "tasks" },
    { name: "after Chat: the last open", events: [toChat], tab: "chat" },
    {
      name: "after going back to Tasks: the last open",
      events: [toChat, toTasks],
      tab: "tasks",
    },
    {
      name: "an island click from Chat: always Tasks",
      events: [toChat, islandClick],
      tab: "tasks",
    },
  ])("$name", ({ events, tab }) => {
    expect(run(events).tab).toBe(tab);
  });
});
