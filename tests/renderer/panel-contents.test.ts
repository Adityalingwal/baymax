import { describe, expect, it } from "vitest";
import type { TaskCard } from "../../src/shared/cards";
import {
  fieldPlaceholder,
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
    { name: "the first time: Chat", events: [], tab: "chat" },
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
    answer: { cardText, sources: [] },
    canRetry: false,
    finishOrder: 1,
  };
}

const atFivePast = new Date(2026, 9, 30, 14, 5).getTime();
const display = {
  tasks: [card("t1", "A report."), card("t2", "")],
  chat: [
    {
      id: "c1",
      from: "user" as const,
      text: "hi",
      at: atFivePast,
      taskId: null,
    },
    {
      id: "c2",
      from: "baymax" as const,
      text: "hello",
      at: atFivePast,
      taskId: null,
    },
  ],
};

describe("the field's placeholder", () => {
  it.each([
    { label: "⌥", placeholder: "Ask, or hold ⌥ to talk to Baymax" },
    { label: "", placeholder: "Ask Baymax" },
  ])("with the label '$label': $placeholder", ({ label, placeholder }) => {
    expect(fieldPlaceholder(label)).toBe(placeholder);
  });
});

describe("the Chat tab", () => {
  it("lists only the conversation, oldest first, each on its side", () => {
    expect(panelContent(run([toChat]), display)).toEqual({
      kind: "chat",
      rows: [
        expect.objectContaining({ id: "c1", side: "left", text: "hi" }),
        expect.objectContaining({ id: "c2", side: "right", text: "hello" }),
      ],
    });
  });
});

describe("a Chat row's report button", () => {
  it.each<{ name: string; taskId: string | null; reportOf: string | null }>([
    { name: "a result line with a report", taskId: "t1", reportOf: "t1" },
    { name: "a task with no report", taskId: "t2", reportOf: null },
    { name: "a task that is gone", taskId: "t9", reportOf: null },
    { name: "a line of no task", taskId: null, reportOf: null },
  ])("$name: $reportOf", ({ taskId, reportOf }) => {
    const chat = [
      { id: "c1", from: "baymax" as const, text: "x", at: 0, taskId },
    ];
    expect(panelContent(run([toChat]), { ...display, chat })).toEqual({
      kind: "chat",
      rows: [expect.objectContaining({ reportOf })],
    });
  });
});

describe("what the panel shows", () => {
  it.each<{ name: string; events: PanelViewEvent[]; kind: string }>([
    { name: "Chat at first", events: [], kind: "chat" },
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
      name: "the list after a click on Tasks on the report page",
      events: [openReport, toTasks],
      kind: "tasks",
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
