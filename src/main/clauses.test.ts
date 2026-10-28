import { describe, expect, it } from "vitest";
import { takeClauses } from "./clauses";

type Row = {
  name: string;
  text: string;
  ended: boolean;
  clauses: string[];
  rest: string;
};

const rows: Row[] = [
  {
    name: "a short line still being written waits",
    text: "I'll check",
    ended: false,
    clauses: [],
    rest: "I'll check",
  },
  {
    name: "a short line that ended is one clause",
    text: "Hi there.",
    ended: true,
    clauses: ["Hi there."],
    rest: "",
  },
  {
    name: "punctuation and a space end a clause",
    text: "Sure, I'll check tomorrow's forecast. The rain",
    ended: false,
    clauses: ["Sure,", "I'll check tomorrow's forecast."],
    rest: "The rain",
  },
  {
    name: "a mark not yet followed by a space waits, since 3.5 may still be coming",
    text: "It is 3.",
    ended: false,
    clauses: [],
    rest: "It is 3.",
  },
  {
    name: "about 40 characters without punctuation are cut at the last space",
    text: "this sentence has no punctuation at all and keeps on going",
    ended: false,
    clauses: ["this sentence has no punctuation at all"],
    rest: "and keeps on going",
  },
  {
    name: "a long word with no space is cut at 40 characters",
    text: "a".repeat(45),
    ended: false,
    clauses: ["a".repeat(40)],
    rest: "aaaaa",
  },
  {
    name: "blank text gives nothing",
    text: "   ",
    ended: true,
    clauses: [],
    rest: "",
  },
];

describe("clauses for streamed speech", () => {
  it.each(rows)("$name", ({ text, ended, clauses, rest }) => {
    expect(takeClauses(text, ended)).toEqual({ clauses, rest });
  });
});
