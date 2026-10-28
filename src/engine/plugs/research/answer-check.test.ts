import { describe, expect, it } from "vitest";
import type { Answer } from "./answer";
import { answerFindings, checkAnswer } from "./answer-check";

const pages = [
  { id: "s1", url: "https://a.example/1", title: "One", text: "Words." },
  { id: "s2", url: "https://b.example/2", title: "Two", text: "Words." },
  { id: "s3", url: "https://c.example/3", title: "Three", text: "Words." },
];

function answerWith(
  cardText: string,
  sourceIds: string[][] = [["s1"]],
): Answer {
  return {
    spokenLine: "A line.",
    cardText,
    claims: sourceIds.map((ids, index) => ({
      claim: `Claim ${index + 1}`,
      sourceIds: ids,
    })),
    openPoints: [],
    status: "complete",
    nextQuestion: null,
  };
}

const rewrites: [string, string][] = [
  ["A loop [s1].", "A loop."],
  ["31°C [s1][s3].", "31°C."],
  ["[s1] First", "First"],
  ["Fact [S1] here", "Fact here"],
  ["Fact [s1, s2] here", "Fact here"],
  ["A loop [[s1]].", "A loop \\[\\]."],
  ["see [docs](https://x.example)", "see \\[docs\\](https://x.example)"],
  ["at <https://x.example>", "at \\<https://x.example>"],
  ["Kept \\[s1\\] pair", "Kept \\[s1\\] pair"],
];

describe("answerFindings card text", () => {
  it.each(rewrites)("rewrites %j to %j", (text, expected) => {
    expect(answerFindings(answerWith(text), pages).cardText).toBe(expected);
  });
});

describe("checkAnswer sources and rules", () => {
  it("passes valid claims with no marker in the card", () => {
    const check = checkAnswer(answerWith("Plain prose."), pages);
    expect(check).toMatchObject({ passed: true });
  });

  it("takes sources only from the claims' ids, in read order, ignoring markers", () => {
    const answer = answerWith("A [s3] and B.", [["s2"], ["s1", "s2"]]);
    const { sources } = answerFindings(answer, pages);
    expect(sources.map((source) => source.id)).toEqual(["s1", "s2"]);
  });

  it.each([
    ["no claims", answerWith("Prose.", []), "claimWithoutSource"],
    [
      "a claim with no ids",
      answerWith("Prose.", [["s1"], []]),
      "claimWithoutSource",
    ],
    [
      "an id that was not read",
      answerWith("Prose.", [["s1", "s9"]]),
      "unreadCitation",
    ],
  ])("fails %s", (_name, answer, rule) => {
    expect(checkAnswer(answer, pages)).toMatchObject({ passed: false, rule });
  });
});
