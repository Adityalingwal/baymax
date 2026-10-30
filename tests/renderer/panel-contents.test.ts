import { describe, expect, it } from "vitest";
import type { TaskCard } from "../../src/shared/cards";
import {
  initialView,
  panelContent,
  viewReducer,
} from "../../src/renderer/panel-contents";
import type {
  PanelTab,
  PanelViewEvent,
} from "../../src/renderer/panel-contents";

const toChat: PanelViewEvent = { kind: "tab", tab: "chat" };
const toTasks: PanelViewEvent = { kind: "tab", tab: "tasks" };
const islandClick: PanelViewEvent = { kind: "open-result" };
const openReport: PanelViewEvent = { kind: "open-report", taskId: "t1" };
const back: PanelViewEvent = { kind: "back" };

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

function card(taskId: string, cardText: string): TaskCard {
  return {
    taskId,
    state: "done",
    words: taskId,
    title: null,
    parentTaskId: null,
    line: null,
    spokenLine: "Done.",
    step: null,
    sourcesRead: 0,
    answer: { cardText, sources: [] },
    canRetry: false,
    finishOrder: 1,
  };
}

const display = {
  tasks: [card("t1", "A report."), card("t2", "")],
  chat: [{ id: "c1", from: "user" as const, text: "hi", at: 0 }],
};

describe("what the panel shows", () => {
  it.each<{ name: string; events: PanelViewEvent[]; kind: string }>([
    { name: "the Tasks list at first", events: [], kind: "tasks" },
    {
      name: "the report page from a card",
      events: [openReport],
      kind: "report",
    },
    {
      name: "the list again after Back",
      events: [openReport, back],
      kind: "tasks",
    },
    {
      name: "Chat over an open report",
      events: [openReport, toChat],
      kind: "chat",
    },
    {
      name: "the report again on coming back to Tasks",
      events: [openReport, toChat, toTasks],
      kind: "report",
    },
    {
      name: "the list after an island click, never a report",
      events: [openReport, islandClick],
      kind: "tasks",
    },
    {
      name: "the list when the report has nothing in it",
      events: [{ kind: "open-report", taskId: "t2" }],
      kind: "tasks",
    },
    {
      name: "the list when the task is gone",
      events: [{ kind: "open-report", taskId: "t9" }],
      kind: "tasks",
    },
  ])("$name: $kind", ({ events, kind }) => {
    expect(panelContent(run(events), display).kind).toBe(kind);
  });
});
