import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import {
  askClarify,
  askNew,
  createHarness,
  finish,
  intake,
  newTask,
} from "./harness";
import { fixedLines } from "./lines";

type SilenceRow = {
  name: string;
  act: (h: Harness) => void;
  silenced: string[];
};

function failedIntake(h: Harness): void {
  h.state.ask("hi", null, null);
  h.state.receive({ type: "failure", taskId: "t1", kind: "modelsUnreachable" });
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
      failedIntake(h);
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
    name: "closing a done card",
    act: (h) => {
      askNew(h, "hermes");
      finish(h, "t1");
      h.state.closeCard("t1");
    },
    silenced: ["t1"],
  },
  {
    name: "removing the thinking card of words that answer the question",
    act: (h) => {
      askClarify(h, "q1");
      h.state.ask("the second", null, h.state.waitingQuestion());
      h.state.receive(
        intake("t2", {
          route: "answer",
          waitingTaskId: "t1",
          questionId: "q1",
          reply: { kind: "choice", index: 1 },
        }),
      );
    },
    silenced: ["t2"],
  },
];

describe("silencing a task's speech", () => {
  it.each(silenceRows)("silences on $name", ({ act, silenced }) => {
    const h = createHarness();
    act(h);
    expect(h.silenced).toEqual(silenced);
  });

  it.each(["thinking", "running"])(
    "silences a %s task before the cancel is sent",
    (state) => {
      const h = createHarness();
      if (state === "running") askNew(h, "hermes");
      else h.state.ask("hi", null, null);
      h.state.cancelTask("t1");
      const silencedAt = h.timeline.indexOf("silence t1");
      expect(silencedAt).toBeGreaterThanOrEqual(0);
      expect(h.timeline.indexOf("send cancel t1")).toBeGreaterThan(silencedAt);
    },
  );
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
  {
    name: "outside research",
    act: (h) => {
      h.state.ask("book a flight", null, null);
      h.state.receive(intake("t1", { route: "outsideResearch" }));
    },
    line: fixedLines.outsideResearch,
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
    h.state.receive(intake("t1", newTask("hermes")));
    finish(h, "t1");
    expect(h.silenced).toEqual([]);
  });
});
