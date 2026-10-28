import { describe, expect, it } from "vitest";
import { createHarness, finished, flush, frontRequest } from "./talker.harness";

const decide = (input: unknown) => ({ name: "decide", input });

describe("the 10 s deadline", () => {
  it("aborts a stream that sent headers and then stalled, cuts its speech and reports it once", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].onText("I'll ");
    h.advance(9_999);
    expect(h.replies).toEqual([]);
    h.advance(1);
    await flush();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.lines[0].parts).toEqual(["I'll ", "<cut>"]);
    expect(h.replies).toEqual([
      {
        taskId: "t2",
        attemptId: "t2#1",
        reply: { kind: "failed", failure: "modelsUnreachable", text: "I'll" },
      },
    ]);
  });
});

describe("a late result after the deadline", () => {
  it.each([
    ["success", finished("I'll check.", [decide({ route: "chat" })])],
    ["failure", { ok: false, failure: "error", detail: "late" } as const],
  ])(
    "changes nothing when a late %s arrives after the deadline",
    async (_name, late) => {
      const h = createHarness({ ignoreAbort: true });
      h.talker.talk(frontRequest());
      h.calls[0].onText("I'll ");
      h.advance(10_000);
      await flush();
      expect(h.calls[0].signal.aborted).toBe(true);
      const spoken = [...h.lines[0].parts];
      h.calls[0].onText("more");
      h.calls[0].onToolStart();
      h.calls[0].resolve(late);
      await flush();
      expect(h.replies).toHaveLength(1);
      expect(h.lines[0].parts).toEqual(spoken);
    },
  );

  it("cancels the deadline when the call finishes in time", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].resolve(finished("Hi.", [decide({ route: "chat" })]));
    await flush();
    h.advance(20_000);
    await flush();
    expect(h.replies).toHaveLength(1);
    expect(h.calls[0].signal.aborted).toBe(false);
  });
});

describe("cancelling an attempt", () => {
  it("before any text: aborts the call, cuts the line and reports nothing", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.talker.cancel("t2#1");
    await flush();
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(h.lines[0].parts).toEqual(["<cut>"]);
    expect(h.replies).toEqual([]);
  });

  it.each([
    ["success", finished("I'll check", [decide({ route: "chat" })])],
    ["failure", { ok: false, failure: "error", detail: "late" } as const],
  ])(
    "after text: cuts the spoken line, and a late %s changes nothing",
    async (_name, late) => {
      const h = createHarness({ ignoreAbort: true });
      h.talker.talk(frontRequest());
      h.calls[0].onText("I'll check");
      h.talker.cancel("t2#1");
      expect(h.calls[0].signal.aborted).toBe(true);
      h.calls[0].onText(" more");
      h.calls[0].onToolStart();
      h.calls[0].resolve(late);
      await flush();
      h.advance(20_000);
      expect(h.lines[0].parts).toEqual(["I'll check", "<cut>"]);
      expect(h.replies).toEqual([]);
    },
  );

  it("shutdown cancels every attempt, and a late success changes nothing", async () => {
    const h = createHarness({ ignoreAbort: true });
    h.talker.talk(frontRequest());
    h.talker.talk(frontRequest({ attemptId: "t5#1", taskId: "t5" }));
    h.talker.shutdown();
    h.calls[0].resolve(finished("Hi.", [decide({ route: "chat" })]));
    await flush();
    expect(h.calls.map((call) => call.signal.aborted)).toEqual([true, true]);
    expect(h.lines.map((line) => line.parts)).toEqual([["<cut>"], ["<cut>"]]);
    expect(h.replies).toEqual([]);
  });
});
