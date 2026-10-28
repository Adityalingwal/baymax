import { describe, expect, it } from "vitest";
import type { Findings } from "../../../shared/cards";
import { createTaskBudget } from "../../core/limits";
import { checkRound, readTurn } from "./run-checks";
import type { CheckRun } from "./run-checks";

const url = "http://example.test/one";
const page = { id: "s1", url, title: "Page one", text: "Plain words." };

function checkRun(built: Findings[]): CheckRun {
  return {
    deps: {
      call: () => Promise.reject(new Error("no model call expected")),
      now: () => 0,
      log: () => undefined,
    },
    task: {
      taskId: "task-1",
      budget: createTaskBudget(),
      signal: new AbortController().signal,
    },
    brief: {
      goal: "g",
      resultShape: "r",
      sources: "s",
      limits: "l",
      userWords: "w",
    },
    today: "2026-10-27",
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
describe("checkRound status cards", () => {
  it.each([
    { status: "sourcesThin", nextQuestion: null },
    { status: "needsUser", nextQuestion: "Which Hermes?" },
  ])("saves the $status card as built before it ends", async (row) => {
    const built: Findings[] = [];
    const text = answerWith(row.status, row.nextQuestion);
    const run = checkRun(built);
    const turn = readTurn(run, { kind: "answer", text });
    const end = await checkRound(run, turn);
    const card = {
      cardText: "A loop.",
      sources: [{ id: "s1", url, title: "Page one" }],
      openPoints: [],
    };
    expect(built).toEqual([card]);
    expect(end).toMatchObject({
      kind: "event",
      event: { type: "incomplete", incomplete: { findings: card } },
    });
  });
});
