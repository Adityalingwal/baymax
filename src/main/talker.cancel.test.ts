import { describe, expect, it } from "vitest";
import { createHarness, finished, flush, frontRequest } from "./talker.harness";

const decide = (input: unknown) => ({ name: "decide", input });

type Deadline = {
  name: string;
  words: { at: number; text: string }[]; // text the call streams, at ms after it starts
  toolAt: number | null; // when the tool block starts, which ends the line
  failsAt: number; // when the attempt is reported as failed
  parts: string[]; // what reached speech
  text?: string; // the reply carries the spoken text
};

const deadlines: Deadline[] = [
  {
    name: "no words by 6 s",
    words: [],
    toolAt: null,
    failsAt: 6_000,
    parts: ["<cut>"],
  },
  {
    name: "whitespace only by 6 s",
    words: [{ at: 500, text: "  " }],
    toolAt: null,
    failsAt: 6_000,
    parts: ["  ", "<cut>"],
  },
  {
    name: "words at 1 s and a call that never finishes",
    words: [{ at: 1_000, text: "I'll " }],
    toolAt: null,
    failsAt: 30_000,
    parts: ["I'll ", "<cut>"],
    text: "I'll",
  },
  {
    name: "words at 5.9 s, a line that ended, and a tool that never finishes",
    words: [{ at: 5_900, text: "I'll check." }],
    toolAt: 6_000,
    failsAt: 30_000,
    parts: ["I'll check.", "<end>"],
    text: "I'll check.",
  },
];

// What the fake call does, in time order: its words and the start of its tool.
function scripted(h: ReturnType<typeof createHarness>, row: Deadline) {
  const words = row.words.map((word) => ({
    at: word.at,
    run: () => h.calls[0].onText(word.text),
  }));
  const tool =
    row.toolAt === null
      ? []
      : [{ at: row.toolAt, run: () => h.calls[0].onToolStart() }];
  return [...words, ...tool].sort((a, b) => a.at - b.at);
}

describe("the two front deadlines", () => {
  it.each(deadlines)(
    "$name: fails once at the right time with both timers cleared",
    async (row) => {
      const h = createHarness();
      h.talker.talk(frontRequest());
      expect(h.pendingTimers()).toBe(2);
      let now = 0;
      const to = (ms: number) => {
        h.advance(ms - now);
        now = ms;
      };
      const events = scripted(h, row);
      for (const event of events) {
        to(event.at);
        event.run();
      }
      to(row.failsAt - 1);
      await flush();
      expect(h.replies).toEqual([]);
      expect(h.calls[0].signal.aborted).toBe(false);
      to(row.failsAt);
      await flush();
      expect(h.calls[0].signal.aborted).toBe(true);
      expect(h.lines[0].parts).toEqual(row.parts);
      expect(h.replies).toEqual([
        {
          taskId: "t2",
          attemptId: "t2#1",
          reply: {
            kind: "failed",
            failure: "modelsUnreachable",
            ...(row.text === undefined ? {} : { text: row.text }),
          },
        },
      ]);
      expect(h.pendingTimers()).toBe(0);
      to(60_000);
      await flush();
      expect(h.replies).toHaveLength(1);
    },
  );
});

describe("the front deadlines end with the attempt", () => {
  it("clears both timers when the call finishes in time", async () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.advance(3_000);
    h.calls[0].resolve(finished("Hi.", [decide({ route: "chat" })]));
    await flush();
    expect(h.pendingTimers()).toBe(0);
    h.advance(60_000);
    await flush();
    expect(h.replies).toHaveLength(1);
    expect(h.calls[0].signal.aborted).toBe(false);
  });

  it.each([
    ["a failed call", { ok: false, failure: "error", detail: "x" } as const],
    ["a call that finished with no tool", finished("Hi.", [])],
  ])("clears both timers after %s", async (_name, outcome) => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.calls[0].resolve(outcome);
    await flush();
    expect(h.pendingTimers()).toBe(0);
  });

  it("clears both timers on cancel and on shutdown", () => {
    const h = createHarness();
    h.talker.talk(frontRequest());
    h.talker.talk(frontRequest({ attemptId: "t5#1", taskId: "t5" }));
    expect(h.pendingTimers()).toBe(4);
    h.talker.cancel("t2#1");
    expect(h.pendingTimers()).toBe(2);
    h.talker.shutdown();
    expect(h.pendingTimers()).toBe(0);
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
      h.advance(30_000);
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
