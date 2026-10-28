import { afterEach, describe, expect, it } from "vitest";
import { judgeInstructions } from "./plugs/research/judge-prompt";
import {
  closeRuns,
  runTask,
  startRun,
  toolUseReply,
  verdictReply,
  workerAnswer,
  pageUrl,
} from "./run.harness";

afterEach(closeRuns);

const oneCited = {
  cardText: "Hermes runs a loop.",
  claims: [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }],
};

const currentFactRule =
  "A page for another place, another date or an unclear date does not back it: set claimsBacked to false and name the gap.";

describe("runTask judge date", () => {
  it("starts the judge's message with today's date, the same day the worker got", async () => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer(oneCited),
      verdictReply(),
    ]);
    run.port.send(runTask());
    await run.ended();
    const judge = run.requests[2];
    expect(judge.system).toBe(judgeInstructions);
    const message = judge.messages[0].content;
    expect(typeof message === "string" ? message : "").toMatch(
      /^Today's date: 2026-10-27\.\n\n<brief>/,
    );
    expect(JSON.stringify(run.requests[0].messages)).toContain("2026-10-27");
  });

  it("keeps the fixed instructions free of any date and holds the current-fact rule", () => {
    expect(judgeInstructions).toContain(currentFactRule);
    expect(judgeInstructions).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
