import { describe, expect, it } from "vitest";
import type { Findings } from "../../../shared/cards";
import { runRounds } from "./rounds";
import type { CheckRun } from "./rounds";

const url = "http://example.test/one";
const page = { id: "s1", url, title: "Page one", text: "Plain words." };

function checkRun(built: Findings[]): CheckRun {
  return {
    deps: {
      call: () => Promise.reject(new Error("no model call expected")),
      now: () => 0,
      log: () => undefined,
    },
    task: { taskId: "task-1" },
    pages: () => [page],
    found: () => null,
    built: (findings) => built.push(findings),
  };
}

const answerWith = (status: string, nextQuestion: string | null) =>
  JSON.stringify({
    spokenLine: "Little was found.",
    cardText: "A loop.",
    claims: [{ claim: "A loop", sourceIds: ["s1"] }],
    openPoints: [],
    status,
    nextQuestion,
  });

// A cancel can land between this card being built and the run settling, so the run's snapshot gets it at once.
describe("status cards of a round", () => {
  it.each([
    { status: "sourcesThin", nextQuestion: null },
    { status: "needsUser", nextQuestion: "Which Hermes?" },
  ])("saves the $status card as built before it ends", async (row) => {
    const built: Findings[] = [];
    const text = answerWith(row.status, row.nextQuestion);
    const run = checkRun(built);
    const end = await runRounds({
      checks: run,
      history: [],
      work: async () => ({ kind: "turn", turn: { kind: "answer", text } }),
      researchMark: () => 0,
    });
    const card = {
      cardText: "A loop.",
      sources: [{ id: "s1", url, title: "Page one" }],
      openPoints: [],
    };
    expect(built).toEqual([card]);
    expect(end).toMatchObject({
      type: "incomplete",
      incomplete: { findings: card },
    });
  });
});
