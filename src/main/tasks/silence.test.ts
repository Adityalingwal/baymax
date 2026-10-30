import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import {
  askClarify,
  askNew,
  createHarness,
  finish,
  newTask,
  outsideResearch,
  questionIdOf,
} from "./harness";
import { fixedLines } from "./lines";

type SilenceRow = {
  name: string;
  act: (h: Harness) => void;
  silenced: string[];
};

function failedFront(h: Harness): void {
  h.state.ask("hi", null, null);
  h.replyFailed("t1", "modelsUnreachable");
}

const silenceRows: SilenceRow[] = [
  {
    name: "cancelling a queued task",
    act: (h) => {
      askNew(h, "hermes");
      askNew(h, "rust");
      h.state.cancelTask("t2");
    },
    silenced: ["t2"],
  },
  {
    name: "cancelling a thinking task with nothing sent",
    act: (h) => {
      failedFront(h);
      h.state.cancelTask("t1");
    },
    silenced: ["t1"],
  },
  {
    name: "cancelling a thinking task whose front call is in flight",
    act: (h) => {
      h.state.ask("hi", null, null);
      h.state.cancelTask("t1");
    },
    silenced: ["t1"],
  },
  {
    name: "cancelling a running task, then the engine confirming",
    act: (h) => {
      askNew(h, "hermes");
      h.state.cancelTask("t1");
      h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
    },
    silenced: ["t1", "t1"],
  },
  {
    name: "the engine cancelling a task unasked",
    act: (h) => {
      askNew(h, "hermes");
      h.state.receive({ type: "cancelled", taskId: "t1", findings: null });
    },
    silenced: ["t1"],
  },
  {
    name: "nothing when removing the thinking card of words that answer the question, whose talker reply still plays",
    act: (h) => {
      askClarify(h);
      h.state.ask("the second", null, h.state.waitingQuestion());
      h.reply("t2", newTask("x", questionIdOf("t1")));
    },
    silenced: [],
  },
];

describe("silencing a task's speech", () => {
  it.each(silenceRows)("silences on $name", ({ act, silenced }) => {
    const h = createHarness();
    act(h);
    expect(h.silenced).toEqual(silenced);
  });

  it("silences a running task before its cancel is sent", () => {
    const h = createHarness();
    askNew(h, "hermes");
    h.state.cancelTask("t1");
    const silencedAt = h.timeline.indexOf("silence t1");
    expect(silencedAt).toBeGreaterThanOrEqual(0);
    expect(h.timeline.indexOf("send cancel t1")).toBeGreaterThan(silencedAt);
  });

  it("silences a thinking task and aborts its front call, sending no cancel", () => {
    const h = createHarness();
    h.state.ask("hi", null, null);
    h.state.cancelTask("t1");
    expect(h.timeline).toEqual(
      expect.arrayContaining(["silence t1", "cancel t1#1"]),
    );
    expect(h.sent).toEqual([]);
  });
});

type SaidRow = { name: string; act: (h: Harness) => void; line: string };

const saidRows: SaidRow[] = [
  {
    name: "queue full",
    act: (h) => {
      for (const name of ["hermes", "rust", "zig", "go", "c"]) {
        askNew(h, name);
      }
    },
    line: fixedLines.queueFull,
  },
];

describe("ending cancelled with a line", () => {
  it.each(saidRows)(
    "says the $name line and silences nothing, even after the leave timer",
    ({ act, line }) => {
      const h = createHarness();
      act(h);
      expect(h.said.at(-1)).toMatchObject({ text: line, kind: "failure" });
      h.advance(3000);
      expect(h.silenced).toEqual([]);
    },
  );

  it("does not silence again when the leave timer hides a cancelled card", () => {
    const h = createHarness();
    askNew(h, "hermes");
    askNew(h, "rust");
    h.state.cancelTask("t2");
    h.advance(3000);
    expect(h.card("t2")).toBeUndefined();
    expect(h.silenced).toEqual(["t2"]);
  });

  it("silences nothing for a new task that starts", () => {
    const h = createHarness();
    h.state.ask("hi", null, null);
    h.reply("t1", newTask("hermes"));
    finish(h, "t1");
    expect(h.silenced).toEqual([]);
  });

  it("says nothing and silences nothing for outside research, even after the leave timer", () => {
    const h = createHarness();
    h.state.ask("book a flight", null, null);
    h.reply("t1", outsideResearch(), "I can't book flights.");
    h.advance(3000);
    expect(h.said).toEqual([]);
    expect(h.silenced).toEqual([]);
  });
});
