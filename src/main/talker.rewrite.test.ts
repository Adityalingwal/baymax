import { describe, expect, it } from "vitest";
import { createHarness, flush, userText } from "./talker.harness";
import type { TalkRequest } from "./tasks/talk";

const question: TalkRequest = {
  kind: "question",
  taskId: "t1",
  question: "Which laptop do you mean?",
  choices: ["MacBook Air", "MacBook Pro"],
};
const result: TalkRequest = {
  kind: "result",
  taskId: "t1",
  text: "Hermes runs a loop of 3 agents.",
};

describe("the talker's rewrites (L14, L15b)", () => {
  it("says a clarifying question in its own words, given the question and its choices, keeping the facts", async () => {
    const h = createHarness();
    h.talker.talk(question);
    const [{ request }] = h.calls;
    expect(request.system).toContain(
      "Keep every fact, number, name and choice of the given text; only change the wording.",
    );
    expect(userText(request)).toContain("- MacBook Air\n- MacBook Pro");
    h.calls[0].onText("Air or Pro?");
    h.calls[0].resolve({ ok: true, text: "Air or Pro?" });
    await flush();
    expect(h.lines).toEqual([
      { taskId: "t1", kind: "question", parts: ["Air or Pro?", "<end>"] },
    ]);
  });
});

describe("a talker rewrite that fails early", () => {
  it.each([
    [
      "fails",
      (h: ReturnType<typeof createHarness>) =>
        h.calls[0].resolve({ ok: false, failure: "unreachable", detail: "x" }),
    ],
    [
      "times out at 3 s",
      (h: ReturnType<typeof createHarness>) => {
        h.advance(3000);
        expect(h.calls[0].signal.aborted).toBe(true);
        h.calls[0].onText("too late");
        h.calls[0].resolve({ ok: false, failure: "aborted", detail: "x" });
      },
    ],
  ])(
    "says the result's line as written when the call %s before any words",
    async (_name, settle) => {
      const h = createHarness();
      h.talker.talk(result);
      h.advance(2999);
      expect(h.calls[0].signal.aborted).toBe(false);
      settle(h);
      await flush();
      expect(h.lines).toEqual([
        {
          taskId: "t1",
          kind: "answer",
          parts: ["Hermes runs a loop of 3 agents.", "<end>"],
        },
      ]);
    },
  );
});

describe("a talker rewrite that fails late, or has no key", () => {
  it("ends where it is when the call fails after its words started, never repeating them", async () => {
    const h = createHarness();
    h.talker.talk(result);
    h.calls[0].onText("Hermes runs");
    h.advance(3000);
    expect(h.calls[0].signal.aborted).toBe(false);
    h.calls[0].resolve({ ok: false, failure: "unreachable", detail: "x" });
    await flush();
    expect(h.lines[0].parts).toEqual(["Hermes runs", "<end>"]);
  });

  it("says the question as written without an Anthropic key", async () => {
    const h = createHarness({ noKey: true });
    h.talker.talk(question);
    await flush();
    expect(h.lines[0].parts).toEqual(["Which laptop do you mean?", "<end>"]);
  });
});
