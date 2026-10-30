import { describe, expect, it } from "vitest";
import type { ModelFailure } from "../../src/providers/anthropic";
import { ipcChannels } from "../../src/shared/ipc";
import { finished } from "./talker.harness";
import {
  replyRoute,
  askRoute,
  decision,
  findings,
  stopRoute,
  workOnRoute,
  workRoute,
} from "./tasks/harness";
import { admitAs, failFront, streamFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const clockStart = Date.UTC(2026, 9, 31, 12);

const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

// Everything said once speech has played out: the front call's own line, then main's lines.
async function spokenAll(w: Wired): Promise<string[]> {
  await flush();
  await w.playAll();
  return w.spoken();
}

const tasksShown = (w: Wired) => w.published.at(-1)?.tasks ?? [];

describe("the routes of a front decision", () => {
  it("reply: the line is spoken, with no card and no worker, and the words and line join Chat", async () => {
    const w = wire();
    ask(w, "thanks!");
    w.advance(5);
    await streamFront(w, replyRoute(), "You're welcome!");
    expect(tasksShown(w)).toEqual([]);
    expect(w.published.at(-1)?.chat).toEqual([
      { id: "c1", from: "user", text: "thanks!", at: clockStart + 5 },
      { id: "c2", from: "baymax", text: "You're welcome!", at: clockStart + 5 },
    ]);
    expect(w.port.sent).toEqual([]);
    expect(await spokenAll(w)).toEqual(["You're welcome!"]);
    expect(w.talkerCalls).toHaveLength(1);
  });

  it("reply: the Chat list keeps the 200 latest entries", async () => {
    const w = wire();
    for (let i = 0; i < 101; i += 1) {
      ask(w, `hi ${i}`);
      await streamFront(w, replyRoute(), `Hello ${i}.`);
    }
    const chat = w.published.at(-1)?.chat ?? [];
    expect(chat).toHaveLength(200);
    expect(chat[0]).toMatchObject({ id: "c3", text: "hi 1" });
    expect(chat.at(-1)).toMatchObject({ id: "c202", text: "Hello 100." });
  });

  it("work: a running card with the topic, the goal and words go to the engine, and nothing more is said", async () => {
    const w = wire();
    ask(w, "  will it rain?  ");
    expect(tasksShown(w)).toEqual([]);
    await streamFront(w, workRoute("the forecast"), "I'll check the forecast.");
    expect(w.card("t1")).toMatchObject({
      state: "running",
      title: "the forecast",
      sayBack: null,
      line: null,
      reply: "I'll check the forecast.",
      parentTaskId: null,
    });
    expect(w.port.sent).toEqual([
      {
        type: "runTask",
        taskId: "t1",
        goalVersion: 1,
        depth: "normal",
        ask: { goal: "the forecast", userWords: "will it rain?" },
        parent: null,
      },
    ]);
    expect(w.chat()).toEqual([]);
    expect(await spokenAll(w)).toEqual(["I'll check the forecast."]);
  });
});

describe("the routes of a front decision while work runs", () => {
  it("reply: words that can be answered at once leave the running task alone and queue nothing", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    const sent = w.port.sent.length;
    ask(w, "book a cab");
    await streamFront(w, replyRoute(), "I can't book cabs.");
    expect(tasksShown(w).map((card) => card.taskId)).toEqual(["t1"]);
    expect(w.card("t1")?.state).toBe("running");
    expect(w.port.sent).toHaveLength(sent);
    expect(w.chat()).toEqual(["book a cab", "I can't book cabs."]);
  });

  it("stop on a running task: the engine gets a cancel, the stop line finishes playing and no card is left", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await w.playAll();
    ask(w, "stop that");
    await streamFront(w, stopRoute("t1"), "Stopping hermes.");
    expect(w.port.sent.at(-1)).toEqual({ type: "cancel", taskId: "t1" });
    expect(w.card("t1")?.state).toBe("cancelling");
    expect(tasksShown(w).map((card) => card.taskId)).toEqual(["t1"]);
    expect(await spokenAll(w)).toEqual([
      "Checking hermes.",
      "Stopping hermes.",
    ]);
    expect(w.stops).toEqual([]);
    expect(w.chat()).toEqual([]);
  });

  it("stop on a queued task: it ends at once and the running one carries on", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await admitAs(w, "rust");
    ask(w, "drop rust");
    await streamFront(w, stopRoute("t2"), "Dropping rust.");
    expect(w.card("t2")?.state).toBe("cancelled");
    expect(w.card("t1")?.state).toBe("running");
    expect(w.port.sent.map((command) => command.type)).toEqual(["runTask"]);
  });
});

describe("the tasks block", () => {
  it("lists only running and queued tasks with the room left", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    await admitAs(w, "rust");
    ask(w, "what do you think?");
    await streamFront(w, askRoute(), "About what?");
    ask(w, "hello");
    await streamFront(w, replyRoute(), "Hello.", 3);
    ask(w, "next");
    expect(String(w.talkerCalls[4].request.messages.at(-1)?.content)).toContain(
      "<running_and_waiting_tasks>\n- task t1 (running) | title: hermes | words: tell me hermes\n- task t2 (queued) | title: rust | words: tell me rust\n1 running, 1 waiting, room for 2 more\n</running_and_waiting_tasks>",
    );
  });

  it.each([
    { tasks: 0, line: "0 running, 0 waiting, room for 4 more" },
    { tasks: 4, line: "1 running, 3 waiting, no room" },
  ])("with $tasks tasks says $line", async ({ tasks, line }) => {
    const w = wire();
    for (let i = 0; i < tasks; i += 1) await admitAs(w, `task ${i}`);
    ask(w, "next");
    const turn = String(w.talkerCalls.at(-1)?.request.messages.at(-1)?.content);
    expect(turn).toContain(`${line}\n</running_and_waiting_tasks>`);
  });
});

describe("a follow-up of an unknown task", () => {
  it("a follow-up naming an unknown task is admitted as a new task and logged", async () => {
    const w = wire();
    ask(w, "and more");
    await streamFront(w, workOnRoute("t9", "more"));
    expect(w.card("t1")).toMatchObject({
      state: "running",
      parentTaskId: null,
    });
    expect(w.logs).toContain("t1 names parent t9; admitted as a new task");
  });
});

const missedLine = "Sorry, I missed that. Ask again.";
const stalledLine = "That didn't go through. Ask again.";

// The front call speaks its text, then fails or ends with no tool.
async function speakThen(w: Wired, text: string, end: ModelFailure | "noTool") {
  const call = w.talkerCalls.find((other) => !other.settled);
  if (call === undefined) throw new Error("no front call to settle");
  call.onText(text);
  call.resolve(
    end === "noTool"
      ? finished(text, [], "end_turn")
      : { ok: false, failure: end, detail: "x" },
  );
  await flush();
}

type Fail = {
  name: string;
  fail: (w: Wired) => Promise<void>;
  line: string;
  spoken: string[];
};

const failures: Fail[] = [
  {
    name: "a rejected key with nothing spoken",
    fail: (w) => failFront(w, "keyRejected"),
    line: "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
    spoken: [
      "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
    ],
  },
  {
    name: "no credit with nothing spoken",
    fail: (w) => failFront(w, "noCredit"),
    line: "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
    spoken: [
      "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
    ],
  },
  {
    name: "unreachable models with nothing spoken",
    fail: (w) => failFront(w, "unreachable"),
    line: missedLine,
    spoken: [missedLine],
  },
  {
    name: "an error with nothing spoken",
    fail: (w) => failFront(w, "error"),
    line: missedLine,
    spoken: [missedLine],
  },
  {
    name: "an error after the line was spoken",
    fail: (w) => speakThen(w, "I'll check laptops.", "error"),
    line: stalledLine,
    spoken: ["I'll check laptops.", stalledLine],
  },
  {
    name: "unreachable models after the line was spoken",
    fail: (w) => speakThen(w, "I'll check.", "unreachable"),
    line: stalledLine,
    spoken: ["I'll check.", stalledLine],
  },
  {
    name: "a call with no tool",
    fail: (w) => speakThen(w, "It's four.", "noTool"),
    line: stalledLine,
    spoken: ["It's four.", stalledLine],
  },
  {
    name: "a decision that fails a check",
    fail: (w) => streamFront(w, decision({ route: "newTask", topic: "x" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "a decision with only its route",
    fail: (w) => streamFront(w, { route: "newTask" }),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "an unknown route",
    fail: (w) => streamFront(w, decision({ route: "dance" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "route retry, not built yet",
    fail: (w) => streamFront(w, decision({ route: "retry", taskId: "t1" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "a stop naming no task",
    fail: (w) => streamFront(w, decision({ route: "stop" })),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
  {
    name: "a stop naming a task that is not running",
    fail: (w) => streamFront(w, stopRoute("t9")),
    line: stalledLine,
    spoken: ["Okay.", stalledLine],
  },
];

const counts = (w: Wired) => [
  w.published.length,
  w.talkerCalls.length,
  w.port.sent.length,
  w.syntheses.length,
];

describe("a front call that fails", () => {
  it.each(failures)(
    "$name says the line for its cause, shows no card and starts no worker",
    async ({ fail, line, spoken }) => {
      const w = wire();
      ask(w, "what is 2 + 2?");
      await fail(w);
      expect(tasksShown(w)).toEqual([]);
      expect(w.chat()).toEqual(["what is 2 + 2?", line]);
      expect(await spokenAll(w)).toEqual(spoken);
      expect(w.port.sent).toEqual([]);
    },
  );

  it("has nothing to retry", async () => {
    const w = wire();
    ask(w, "what is 2 + 2?");
    await failFront(w, "error");
    const before = counts(w);
    w.send(ipcChannels.retryTask, { taskId: "t1" });
    expect(counts(w)).toEqual(before);
  });

  it("speaks the models line once when first words are late twice", async () => {
    const w = wire();
    ask(w, "what is 2 + 2?");
    w.advance(10_000);
    await flush();
    w.advance(10_000);
    await flush();
    expect(w.talkerCalls).toHaveLength(2);
    expect(tasksShown(w)).toEqual([]);
    expect(await spokenAll(w)).toEqual([missedLine]);
  });
});

const progress = (taskId: string) =>
  ({
    type: "progress",
    taskId,
    step: { tool: "search", query: "q" },
    sourcesRead: 2,
  }) as const;

const result = (taskId: string, text = "Done.") =>
  ({
    type: "result",
    taskId,
    spokenLine: text,
    findings: findings(text),
  }) as const;

const cancelledEvent = (taskId: string) =>
  ({ type: "cancelled", taskId, findings: null }) as const;

type LateRow = {
  name: string;
  setup: (w: Wired) => Promise<void>;
  act: (w: Wired) => void;
};

const lateRows: LateRow[] = [
  {
    name: "progress for an unknown id",
    setup: async () => undefined,
    act: (w) => w.port.emit(progress("t9")),
  },
  {
    name: "a result for a done task",
    setup: async (w) => {
      await admitAs(w, "hermes");
      w.port.emit(result("t1"));
    },
    act: (w) => w.port.emit(result("t1", "Again.")),
  },
  {
    name: "progress while cancelling",
    setup: async (w) => {
      await admitAs(w, "hermes");
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
    },
    act: (w) => w.port.emit(progress("t1")),
  },
  {
    name: "a second cancelled",
    setup: async (w) => {
      await admitAs(w, "hermes");
      w.send(ipcChannels.cancelTask, { taskId: "t1" });
      w.port.emit(cancelledEvent("t1"));
    },
    act: (w) => w.port.emit(cancelledEvent("t1")),
  },
  {
    name: "a second reply to a running task's front call",
    setup: (w) => admitAs(w, "hermes"),
    act: (w) =>
      w.wiring.state.talkerReplied("t1", "t1#1", {
        kind: "said",
        text: "again",
        decision: replyRoute(),
      }),
  },
  {
    name: "a front failure for a running task",
    setup: (w) => admitAs(w, "hermes"),
    act: (w) =>
      w.wiring.state.talkerReplied("t1", "t1#1", {
        kind: "failed",
        failure: "error",
      }),
  },
  {
    name: "a cancelled event for a queued task",
    setup: async (w) => {
      await admitAs(w, "hermes");
      await admitAs(w, "rust");
    },
    act: (w) => w.port.emit(cancelledEvent("t2")),
  },
  {
    name: "empty words",
    setup: async () => undefined,
    act: (w) => ask(w, "   "),
  },
];

describe("an input that changes nothing", () => {
  it.each(lateRows)(
    "$name publishes, sends and says nothing",
    async ({ setup, act }) => {
      const w = wire();
      await setup(w);
      const before = counts(w);
      act(w);
      await flush();
      expect(counts(w)).toEqual(before);
    },
  );

  it("logs a second reply to the same front call as dropped", async () => {
    const w = wire();
    await admitAs(w, "hermes");
    w.wiring.state.talkerReplied("t1", "t1#1", {
      kind: "said",
      text: "again",
      decision: replyRoute(),
    });
    expect(w.card("t1")).toMatchObject({ state: "running" });
    expect(w.logs.at(-1)).toBe("dropped: front call t1#1 for t1");
  });
});
