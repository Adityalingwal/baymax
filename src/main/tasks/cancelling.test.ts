import { describe, expect, it } from "vitest";
import type { EngineEvent } from "../../shared/engine";
import {
  askFollowUp,
  askNew,
  counts,
  createHarness,
  findings,
  intake,
  newTask,
} from "./harness";

const thinkingReplies: { name: string; reply: EngineEvent }[] = [
  { name: "an intake", reply: intake("t1", newTask("hermes")) },
  {
    name: "a failure",
    reply: { type: "failure", taskId: "t1", kind: "modelsUnreachable" },
  },
];

describe("a reply that ends the step while cancelling", () => {
  it.each(thinkingReplies)(
    "$name ends a thinking task cancelled and drops later events",
    ({ reply }) => {
      const h = createHarness();
      h.state.ask("hi", null, null);
      h.state.cancelTask("t1");
      const [published, sent, said] = counts(h);
      h.state.receive(reply);
      expect(counts(h)).toEqual([published + 1, sent, said]);
      expect(h.card("t1")).toMatchObject({ state: "cancelled", line: null });
      h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
      expect(counts(h)).toEqual([published + 1, sent, said]);
    },
  );

  it("an incomplete ends a running task cancelled and its follow-up gets the findings", () => {
    const h = createHarness();
    askNew(h, "hermes");
    const child = askFollowUp(h, "t1", "more");
    h.state.cancelTask("t1");
    const partial = findings("Part.");
    const [published, , said] = counts(h);
    h.state.receive({
      type: "incomplete",
      taskId: "t1",
      incomplete: { kind: "limitHit", findings: partial },
    });
    expect(h.published.length).toBe(published + 1);
    expect(h.said.length).toBe(said + 1);
    expect(h.said.at(-1)).toEqual({
      taskId: child,
      text: "Hermes was cancelled, so I'll build on what it found.",
      kind: "startLine",
    });
    expect(h.card("t1")).toMatchObject({ state: "cancelled", answer: null });
    expect(h.sent.at(-1)).toEqual(
      expect.objectContaining({
        type: "runTask",
        taskId: child,
        parent: { taskId: "t1", outcome: "cancelled", findings: partial },
      }),
    );
  });
});
