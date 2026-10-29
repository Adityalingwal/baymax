import { describe, expect, it } from "vitest";
import {
  askFollowUp,
  askNew,
  counts,
  createHarness,
  findings,
  newTask,
} from "./harness";

describe("cancelling a task whose front call is in flight", () => {
  it("cancels it at once with no engine message, and a late reply or failure changes nothing", () => {
    const h = createHarness();
    h.state.ask("hi", null, null);
    const [{ attemptId }] = h.talked;
    h.state.cancelTask("t1");
    expect(h.card("t1")).toMatchObject({ state: "cancelled", line: null });
    expect(h.cancelled).toEqual([attemptId]);
    expect(h.silenced).toEqual(["t1"]);
    expect(h.sent).toEqual([]);
    const [published, sent, said] = counts(h);
    h.state.talkerReplied("t1", attemptId, {
      kind: "said",
      text: "Hello.",
      decision: newTask("hermes"),
    });
    h.state.talkerReplied("t1", attemptId, {
      kind: "failed",
      failure: "error",
    });
    h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
    expect(counts(h)).toEqual([published, sent, said]);
    expect(h.card("t1")).toMatchObject({ state: "cancelled", answer: null });
  });
});

describe("a reply that ends the step while cancelling", () => {
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
    // The partial-parent line shows on the follow-up's card; it is not said.
    expect(h.said.length).toBe(said);
    expect(h.card(child)?.line).toBe(
      "Hermes was cancelled, so I'll build on what it found.",
    );
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
