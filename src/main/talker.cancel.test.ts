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
    // A late completion after the deadline changes nothing.
    h.calls[0].resolve(finished("I'll check.", [decide({ route: "chat" })]));
    await flush();
    expect(h.replies).toHaveLength(1);
  });

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

  it("after text: cuts the spoken line, and a late success or failure changes nothing", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].onText("I'll check");
    h.talker.cancel("t2#1");
    h.calls[0].onText(" more");
    h.calls[0].resolve(finished("I'll check", [decide({ route: "chat" })]));
    await flush();
    h.talker.talk(frontRequest({ attemptId: "t2#2" }));
    h.talker.cancel("t2#2");
    h.calls[1].resolve({ ok: false, failure: "error", detail: "late" });
    await flush();
    expect(h.lines[0].parts).toEqual(["I'll check", "<cut>"]);
    expect(h.replies).toEqual([]);
    h.advance(20_000);
    expect(h.replies).toEqual([]);
  });

  it("shutdown cancels every attempt", async () => {
    const h = createHarness();
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
