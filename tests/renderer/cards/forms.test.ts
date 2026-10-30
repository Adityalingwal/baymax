import { describe, expect, it } from "vitest";
import type { Source, TaskState } from "../../../src/shared/cards";
import {
  canCancel,
  cardForm,
  cardTitle,
  shownReport,
  sourceGroups,
  stateLabel,
} from "../../../src/renderer/cards/forms";

const formCases: [TaskState, string][] = [
  ["queued", "pill"],
  ["running", "pill"],
  ["cancelling", "pill"],
  ["cancelled", "pill"],
  ["done", "open"],
  ["failed", "open"],
];

describe("cardForm", () => {
  it.each(formCases)("%s is %s", (state, form) => {
    expect(cardForm({ state })).toBe(form);
  });
});

const stateCases: [TaskState, boolean, string][] = [
  ["queued", true, "Queued"],
  ["running", true, "Running"],
  ["cancelling", false, "Cancelling"],
  ["done", false, "Done"],
  ["failed", false, "Failed"],
  ["cancelled", false, "Cancelled"],
];

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

describe("canCancel and stateLabel", () => {
  it.each(stateCases)("%s: cancel %s, label %s", (state, cancel, label) => {
    expect(canCancel(state)).toBe(cancel);
    expect(stateLabel(state)).toBe(label);
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
