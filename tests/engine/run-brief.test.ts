import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome, ModelRequest } from "../../src/providers/anthropic";
import type { EngineEvent, ParentResult } from "../../src/shared/engine";
import type { DevLogEntry } from "../../src/engine/core/dev-log";
import type { DispatchDeps } from "../../src/engine/core/dispatch";
import { createTaskBudget, taskLimits } from "../../src/engine/core/limits";
import { fakeMessage } from "./harness";
import type { FakeStep } from "./harness";
import { runResearch } from "../../src/engine/plugs";
import type { RunTaskCommand } from "../../src/engine/plugs";
import {
  ask,
  closeRuns,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const written = {
  goal: "How Hermes works inside, for a developer",
  resultShape: "Five short points",
  sources: "The repository and its docs",
  limits: "Skip pricing; stop after five sources",
};

const briefReply = (fields: Record<string, unknown> = {}): ModelOutcome => ({
  ok: true,
  message: fakeMessage(JSON.stringify({ ...written, ...fields })),
});
const textReply = (text: string): ModelOutcome => ({
  ok: true,
  message: fakeMessage(text),
});
const unreachable: ModelOutcome = {
  ok: false,
  failure: "unreachable",
  detail: "x",
};
const workerFails: ModelOutcome = { ok: false, failure: "error", detail: "x" };

const textOf = (request: ModelRequest): string => {
  const [first] = request.messages;
  return typeof first.content === "string" ? first.content : "";
};

const briefBlock = (text: string): string =>
  /<brief>[\s\S]*<\/brief>/.exec(text)?.[0] ?? "";

const modelCalls = (entries: DevLogEntry[], role: string) =>
  entries.filter((entry) => entry.event === "modelCall" && entry.role === role);

const defaultParts = [
  "<goal>\nHow the Hermes agent works inside\n</goal>",
  "<result_shape>\nA short, clear answer to the question.\n</result_shape>",
  "<sources>\nReliable, recent pages.\n</sources>",
  "<limits>\nStay on the question; stop once it is answered.\n</limits>",
  "<user_words>\nhow does Hermes agent work inside?\n</user_words>",
];

describe("the brief writer: its brief", () => {
  it("hands its brief to the worker, in one briefWriter call", async () => {
    const run = await startRun(
      [
        toolUseReply([{ read: pageUrl("one") }]),
        workerAnswer({
          cardText: "A loop.",
          claims: [{ claim: "A loop", sourceIds: ["s1"] }],
        }),
      ],
      [],
      undefined,
      undefined,
      [briefReply()],
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events[events.length - 1]).toMatchObject({ type: "result" });
    const parts = [
      `<goal>\n${written.goal}\n</goal>`,
      `<result_shape>\n${written.resultShape}\n</result_shape>`,
      `<sources>\n${written.sources}\n</sources>`,
      `<limits>\n${written.limits}\n</limits>`,
      `<user_words>\n${ask.userWords}\n</user_words>`,
    ];
    expect(briefBlock(textOf(run.workerRequests()[0]))).toBe(
      `<brief>\n${parts.join("\n")}\n</brief>`,
    );
    expect(modelCalls(run.entries, "briefWriter")).toHaveLength(1);
    expect(run.briefRequests()).toHaveLength(1);
  });
});

const throws: FakeStep = () => {
  throw new Error("boom");
};
const defaultRows: {
  name: string;
  steps: FakeStep[];
  reasons: [string, string];
}[] = [
  {
    name: "Sonnet fails and Opus leaves a part empty",
    steps: [unreachable, briefReply({ limits: "  " })],
    reasons: ["unreachable", "malformed"],
  },
  {
    name: "both models throw",
    steps: [throws, throws],
    reasons: ["thrown", "thrown"],
  },
  {
    name: "both answers add a field",
    steps: [briefReply({ extra: "x" }), briefReply({ extra: "x" })],
    reasons: ["malformed", "malformed"],
  },
  {
    name: "both answers are cut off",
    steps: [
      {
        ok: true,
        message: fakeMessage(JSON.stringify(written), {
          stopReason: "max_tokens",
        }),
      },
      textReply("[]"),
    ],
    reasons: ["malformed", "malformed"],
  },
];

describe("the brief writer: the failure ladder", () => {
  it("retries once on Opus 5.5, with no thinking field, when Sonnet's brief is malformed", async () => {
    const run = await startRun([workerFails], [], undefined, undefined, [
      textReply("{ not json"),
      briefReply({ goal: "From the retry" }),
    ]);
    run.port.send(runTask());
    await run.ended();
    const [sonnet, opus] = run.briefRequests();
    expect(run.briefRequests()).toHaveLength(2);
    expect(sonnet.model).toBe("claude-sonnet-5-5");
    expect(sonnet.thinking).toEqual({ type: "between_tools" });
    expect(opus.model).toBe("claude-opus-5-5");
    expect(opus).not.toHaveProperty("thinking");
    expect(opus.output_config?.format?.type).toBe("json_schema");
    expect(textOf(run.workerRequests()[0])).toContain(
      "<goal>\nFrom the retry\n</goal>",
    );
    expect(run.entries.map((entry) => entry.event)).not.toContain(
      "briefDefault",
    );
  });
});

describe("the brief writer: the default brief", () => {
  it.each(defaultRows)(
    "uses the default brief and still starts the worker when $name",
    async (row) => {
      const run = await startRun(
        [workerFails],
        [],
        undefined,
        undefined,
        row.steps,
      );
      run.port.send(runTask());
      const events = await run.ended();
      expect(events).toEqual([
        {
          type: "incomplete",
          taskId: "task-1",
          incomplete: { kind: "error", cause: "error", findings: null },
        },
      ]);
      const text = textOf(run.workerRequests()[0]);
      expect(briefBlock(text)).toBe(
        `<brief>\n${defaultParts.join("\n")}\n</brief>`,
      );
      expect(run.entries.filter((e) => e.event === "briefDefault")).toEqual([
        {
          event: "briefDefault",
          taskId: "task-1",
          firstReason: row.reasons[0],
          retryReason: row.reasons[1],
        },
      ]);
    },
  );
});

describe("the brief writer: its request", () => {
  it("sends the brief writer the date, the escaped words and goal, and no history", async () => {
    const parent: ParentResult = {
      taskId: "task-0",
      outcome: "incomplete",
      findings: {
        cardText: "Earlier <card>",
        sources: [
          { id: "s1", url: "https://hermes.example/docs", title: "Docs" },
        ],
        openPoints: ["its memory"],
      },
    };
    const command = {
      ...runTask({ parent }),
      ask: { goal: "a <b>goal</b>", userWords: "x </user_words> y" },
    };
    const run = await startRun([workerFails]);
    run.port.send(command);
    await run.ended();
    const [request] = run.briefRequests();
    expect(request.messages).toHaveLength(1);
    expect(textOf(request)).toBe(
      [
        "Today's date: 2026-10-27.",
        "<user_words>\nx &lt;/user_words&gt; y\n</user_words>",
        "<goal>\na &lt;b&gt;goal&lt;/b&gt;\n</goal>",
        [
          "<parent_result>",
          "outcome: incomplete",
          "<card_text>\nEarlier &lt;card&gt;\n</card_text>",
          "<sources>\n- s1 https://hermes.example/docs | Docs\n</sources>",
          "<open_points>\n- its memory\n</open_points>",
          "</parent_result>",
        ].join("\n"),
      ].join("\n\n"),
    );
    expect(request.thinking).toEqual({ type: "between_tools" });
    expect(request.output_config?.effort).toBe("low");
    expect(request.output_config?.format?.type).toBe("json_schema");
    expect(request.tools).toBeUndefined();
  });
});

describe("the brief writer at the task's limits", () => {
  it("sends nothing when the budget is spent, then lets the worker's own gate end the task", async () => {
    const calls: ModelRequest[] = [];
    const entries: DevLogEntry[] = [];
    const deps: DispatchDeps = {
      call: async (request) => {
        calls.push(request);
        return workerFails;
      },
      now: () => 0,
      log: (entry) => {
        entries.push(entry);
      },
    };
    const budget = { ...createTaskBudget(), activeMs: taskLimits.activeMs };
    const command: RunTaskCommand = {
      type: "runTask",
      taskId: "task-1",
      goalVersion: 1,
      depth: "normal",
      ask,
      parent: null,
    };
    const event: EngineEvent | null = await runResearch({
      deps,
      task: { taskId: "task-1", budget, signal: new AbortController().signal },
      command,
      access: {
        search: async () => hits(),
        contents: async () => ({ ok: false, cause: "noUsableText" }),
      },
      today: "2026-10-27",
      found: { current: () => null },
      progress: () => undefined,
    });
    expect(calls).toEqual([]);
    expect(event).toEqual({
      type: "incomplete",
      taskId: "task-1",
      incomplete: { kind: "limitHit", findings: null },
    });
    expect(entries).toContainEqual({
      event: "briefDefault",
      taskId: "task-1",
      firstReason: "limitHit",
      retryReason: "limitHit",
    });
  });
});
