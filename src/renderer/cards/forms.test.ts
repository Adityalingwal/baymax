import { describe, expect, it } from "vitest";
import type { Source, TaskState } from "../../shared/cards";
import { canCancel, cardForm, sourceGroups, stateLabel } from "./forms";

const formCases: [TaskState, boolean, string][] = [
  ["thinking", false, "pill"],
  ["thinking", true, "pill"],
  ["clarifying", false, "question"],
  ["clarifying", true, "question"],
  ["queued", false, "pill"],
  ["queued", true, "pill"],
  ["running", false, "pill"],
  ["running", true, "pill"],
  ["cancelling", false, "pill"],
  ["cancelling", true, "pill"],
  ["cancelled", false, "pill"],
  ["cancelled", true, "pill"],
  ["done", false, "open"],
  ["done", true, "folded"],
  ["incomplete", false, "open"],
  ["incomplete", true, "folded"],
];

describe("cardForm", () => {
  it.each(formCases)("%s with folded %s is %s", (state, folded, form) => {
    expect(cardForm({ state, folded })).toBe(form);
  });
});

const stateCases: [TaskState, boolean, string][] = [
  ["thinking", true, "Thinking"],
  ["clarifying", true, "Clarifying"],
  ["queued", true, "Queued"],
  ["running", true, "Running"],
  ["cancelling", false, "Cancelling"],
  ["done", false, "Done"],
  ["incomplete", false, "Incomplete"],
  ["cancelled", false, "Cancelled"],
];

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
