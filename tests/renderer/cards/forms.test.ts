import { describe, expect, it } from "vitest";
import type { Source, TaskCard } from "../../../src/shared/cards";
import {
  cardContents,
  cardTitle,
  shownReport,
  sourceGroups,
} from "../../../src/renderer/cards/forms";
import type { CardContents } from "../../../src/renderer/cards/forms";

function card(fields: Partial<TaskCard>): TaskCard {
  return {
    taskId: "t1",
    state: "running",
    words: "tell me about hermes",
    title: "Hermes",
    parentTaskId: null,
    line: null,
    spokenLine: null,
    step: null,
    sourcesRead: 0,
    answer: null,
    canRetry: false,
    finishOrder: null,
    ...fields,
  };
}

const page: Source = { id: "s1", url: "https://a.com/1", title: "A page" };
const nothing: CardContents = {
  label: null,
  pulse: false,
  live: null,
  line: null,
  stop: false,
  retry: false,
  report: null,
  sources: [],
};
const withPage = { cardText: "", sources: [page] };

type CardRow = {
  name: string;
  fields: Partial<TaskCard>;
  shows: Partial<CardContents>;
};

const cardRows: CardRow[] = [
  {
    name: "running: label with a dot, the live line and stop",
    fields: { step: "reading a.com" },
    shows: {
      label: "Running",
      pulse: true,
      live: "reading a.com",
      stop: true,
    },
  },
  {
    name: "queued: label and stop, no live line",
    fields: { state: "queued" },
    shows: { label: "Queued", stop: true },
  },
  {
    name: "cancelling keeps its label, with no live line and no stop",
    fields: { state: "cancelling", step: "reading a.com" },
    shows: { label: "Cancelling" },
  },
  {
    name: "cancelled keeps its label",
    fields: { state: "cancelled" },
    shows: { label: "Cancelled" },
  },
  {
    name: "a done card with a report: no label, the summary and the report, its sources on the page",
    fields: {
      state: "done",
      spokenLine: "It runs a loop.",
      answer: { cardText: "A long report.", sources: [page] },
    },
    shows: { line: "It runs a loop.", report: "A long report." },
  },
  {
    name: "a short answer: no button, its sources under the summary",
    fields: { state: "done", spokenLine: "24 degrees.", answer: withPage },
    shows: { line: "24 degrees.", sources: [page] },
  },
  {
    name: "a failed card that can retry: no label, the cause, its pages and Retry",
    fields: {
      state: "failed",
      line: "Search isn't working.",
      canRetry: true,
      answer: { cardText: "- A page", sources: [page] },
    },
    shows: { line: "Search isn't working.", retry: true, sources: [page] },
  },
  {
    name: "a failed card with nothing and no Retry",
    fields: { state: "failed", line: "Search isn't working." },
    shows: { line: "Search isn't working." },
  },
  {
    name: "Retry never shows on a card that is not failed",
    fields: { state: "done", canRetry: true, spokenLine: "Done." },
    shows: { line: "Done." },
  },
];

describe("what each kind of card shows", () => {
  it.each(cardRows)("$name", ({ fields, shows }) => {
    expect(cardContents(card(fields))).toEqual({ ...nothing, ...shows });
  });
});

describe("cardTitle", () => {
  it.each([
    { name: "a topic", title: "Hermes", shown: "Hermes" },
    { name: "no topic yet", title: null, shown: "tell me about hermes" },
  ])("$name shows $shown", ({ title, shown }) => {
    expect(cardTitle({ title, words: "tell me about hermes" })).toBe(shown);
  });
});

describe("shownReport", () => {
  it.each([
    { name: "no answer", answer: null, report: null },
    {
      name: "an empty report",
      answer: { cardText: "", sources: [] },
      report: null,
    },
    {
      name: "a report",
      answer: { cardText: "A loop.", sources: [] },
      report: "A loop.",
    },
  ])("$name: $report", ({ answer, report }) => {
    expect(shownReport({ answer })).toBe(report);
  });
});

function source(id: string, url: string): Source {
  return { id, url, title: `Title ${id}` };
}

const groupCases: [string, Source[], [string, string[]][]][] = [
  [
    "same host grouped, keeping every source",
    [source("a", "https://a.com/1"), source("b", "https://a.com/2")],
    [["a.com", ["a", "b"]]],
  ],
  [
    "www. removed and merged with the bare host",
    [source("a", "https://www.a.com/1"), source("b", "https://a.com/2")],
    [["a.com", ["a", "b"]]],
  ],
  [
    "groups in the order of their first source",
    [
      source("a", "https://b.org/1"),
      source("b", "https://a.com/1"),
      source("c", "https://b.org/2"),
    ],
    [
      ["b.org", ["a", "c"]],
      ["a.com", ["b"]],
    ],
  ],
  [
    "a bad URL is its own group labelled by its title",
    [
      source("a", "not a url"),
      source("b", "https://a.com/1"),
      source("c", "also bad"),
    ],
    [
      ["Title a", ["a"]],
      ["a.com", ["b"]],
      ["Title c", ["c"]],
    ],
  ],
];

describe("sourceGroups", () => {
  it.each(groupCases)("%s", (_name, sources, expected) => {
    const groups = sourceGroups(sources).map((group) => [
      group.label,
      group.sources,
    ]);
    const whole = expected.map(([label, ids]) => [
      label,
      ids.map((id) => sources.find((item) => item.id === id)),
    ]);
    expect(groups).toEqual(whole);
  });
});
