import { describe, expect, it } from "vitest";
import { askClarify, askNew, createHarness, outsideResearch } from "./harness";

describe("card fields per transition", () => {
  it("ends an outside-research request cancelled with the spoken line on it and says nothing more", () => {
    const h = createHarness();
    h.state.ask("book me a flight", null, null);
    h.reply("t1", outsideResearch(), "I can't book flights; I only research.");
    expect(h.card("t1")).toMatchObject({
      state: "cancelled",
      reply: "I can't book flights; I only research.",
      line: null,
      canRetry: false,
    });
    expect(h.said).toEqual([]);
    expect(h.silenced).toEqual([]);
    expect(h.sent).toEqual([]);
    h.advance(3000);
    expect(h.card("t1")).toBeUndefined();
  });

  it.each([
    {
      step: { tool: "search", query: "hermes docs" } as const,
      text: "searching: hermes docs",
    },
    {
      step: { tool: "read", url: "https://github.com/x/y" } as const,
      text: "reading github.com",
    },
  ])("shows a $step.tool step as $text", ({ step, text }) => {
    const h = createHarness();
    askNew(h, "hermes");
    h.state.receive({ type: "progress", taskId: "t1", step, sourcesRead: 1 });
    expect(h.card("t1")).toMatchObject({ step: text, sourcesRead: 1 });
  });
});

describe("card fields on cancel", () => {
  it("changes only state and canRetry when a cancel is sent", () => {
    const h = createHarness();
    askNew(h, "hermes");
    const before = h.card("t1");
    h.state.cancelTask("t1");
    expect(h.card("t1")).toEqual({
      ...before,
      state: "cancelling",
      canRetry: false,
    });
  });

  it("clears the card's fields when a cancelled task ends", () => {
    const h = createHarness();
    askClarify(h);
    h.state.ask("the first one", null, h.state.waitingQuestion());
    h.state.cancelTask("t1");
    expect(h.card("t1")).toMatchObject({
      state: "cancelled",
      line: null,
      step: null,
      question: null,
      answer: null,
      missing: null,
      canRetry: false,
    });
  });
});

describe("a throwing dependency", () => {
  it("logs a failed publish and still sends", () => {
    const h = createHarness();
    h.failPublish("window gone");
    h.state.ask("hi", null, null);
    expect(h.logs).toContain("publish failed: Error: window gone");
    expect(h.talked).toHaveLength(1);
  });

  it("lets a failed send surface to main's restart path", () => {
    const h = createHarness();
    h.replyWith(() => {
      throw new Error("port closed");
    });
    expect(() => askNew(h, "hermes")).toThrow("port closed");
  });
});
