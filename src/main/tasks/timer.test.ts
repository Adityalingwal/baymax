import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import { createHarness, intake, newTask } from "./harness";

const letMeCheck = { taskId: "t1", text: "Let me check.", kind: "letMeCheck" };

const silentRows: { name: string; act: (h: Harness) => void }[] = [
  {
    name: "the intake arrives first",
    act: (h) => {
      h.advance(1499);
      h.state.receive(intake("t1", newTask("hermes")));
    },
  },
  {
    name: "the intake fails first",
    act: (h) => {
      h.advance(1000);
      h.state.receive({ type: "failure", taskId: "t1", kind: "error" });
    },
  },
];

describe("the 1.5 s line", () => {
  it("shows and says Let me check. at 1500 ms, not at 1499 ms", () => {
    const h = createHarness();
    h.state.ask("how does hermes work", null, null);
    h.advance(1499);
    expect(h.said).toEqual([]);
    expect(h.card("t1")?.line).toBeNull();
    h.advance(1);
    expect(h.said).toEqual([letMeCheck]);
    expect(h.card("t1")?.line).toBe("Let me check.");
  });

  it.each(silentRows)("is not said when $name", ({ act }) => {
    const h = createHarness();
    h.state.ask("how does hermes work", null, null);
    act(h);
    h.advance(5000);
    expect(h.said).not.toContainEqual(letMeCheck);
  });
});
