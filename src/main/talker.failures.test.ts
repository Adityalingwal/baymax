import { describe, expect, it } from "vitest";
import { createHarness, finished, flush, frontRequest } from "./talker.harness";

const decide = (input: unknown) => ({ name: "decide", input });

const input = { route: "chat" };

const rows = [
  [
    "a rejected key",
    { ok: false, failure: "keyRejected", detail: "x" },
    "keyRejected",
  ],
  ["no credit", { ok: false, failure: "noCredit", detail: "x" }, "noCredit"],
  [
    "an unreachable model",
    { ok: false, failure: "unreachable", detail: "x" },
    "modelsUnreachable",
  ],
  ["an error", { ok: false, failure: "error", detail: "x" }, "error"],
  ["no text", finished("  ", [decide(input)]), "error"],
  ["a truncated reply", finished("Hi", [decide(input)], "max_tokens"), "error"],
  ["a refusal", finished("No.", [], "refusal"), "error"],
  ["two tools", finished("Hi", [decide(input), decide(input)]), "error"],
  ["another tool", finished("Hi", [{ name: "search", input }]), "error"],
  [
    "a tool without the tool stop",
    finished("Hi", [decide(input)], "end_turn"),
    "error",
  ],
] as const;

describe("a failing front call", () => {
  it.each(rows)(
    "reports %s as %s, never throwing",
    async (_name, outcome, kind) => {
      const h = createHarness();
      h.talker.talk(frontRequest());
      h.calls[0].resolve(outcome);
      await flush();
      const spoken = outcome.ok ? outcome.text.trim() : "";
      expect(h.lines[0].parts).toEqual(["<end>"]);
      expect(h.replies).toEqual([
        {
          taskId: "t2",
          attemptId: "t2#1",
          reply: {
            kind: "failed",
            failure: kind,
            ...(spoken === "" ? {} : { text: spoken }),
          },
        },
      ]);
      expect(h.logs[0]).toContain("talker front call failed");
    },
  );
});

describe("a front call that fails after speaking", () => {
  it("reports the line it already spoke", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].onText("It's ");
    h.calls[0].onText("four.");
    h.calls[0].resolve({ ok: false, failure: "unreachable", detail: "x" });
    await flush();
    expect(h.replies[0].reply).toEqual({
      kind: "failed",
      failure: "modelsUnreachable",
      text: "It's four.",
    });
  });
});

describe("a front call without a key", () => {
  it("fails as a rejected key without an Anthropic key", async () => {
    const h = createHarness({ noKey: true });
    h.talker.talk(frontRequest());
    await flush();
    expect(h.replies[0].reply).toEqual({
      kind: "failed",
      failure: "keyRejected",
    });
  });
});
