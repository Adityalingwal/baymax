import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequest } from "../providers/anthropic";
import type { EngineEvent, ParentResult } from "../shared/engine";
import {
  brief,
  closeRuns,
  goodAnswer,
  hits,
  pageUrl,
  runTask,
  startRun,
  thinkingBlock,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const jsonOnlyLine =
  "The JSON output format applies to your final answer only. When you need a tool, call it first, with no text before the call, and write the JSON once you have the results.";

const happySteps = () => [
  toolUseReply([{ search: "hermes agent internals" }], [thinkingBlock]),
  toolUseReply([{ read: pageUrl("one") }]),
  toolUseReply([{ read: pageUrl("two") }]),
  workerAnswer(),
];

const progress = (
  step: { tool: "search"; query: string } | { tool: "read"; url: string },
  sourcesRead: number,
): EngineEvent => ({ type: "progress", taskId: "task-1", step, sourcesRead });

const promptStart = (request: ModelRequest) =>
  JSON.stringify([request.system, request.tools, request.cache_control]);

const firstText = (request: ModelRequest): string => {
  const [first] = request.messages;
  return typeof first.content === "string" ? first.content : "";
};

describe("runTask happy path", () => {
  it("searches, reads, answers and ends with one checked result", async () => {
    const run = await startRun(happySteps(), [
      hits(pageUrl("one"), pageUrl("two")),
    ]);
    run.port.send(runTask());
    expect(await run.ended()).toEqual([
      progress({ tool: "search", query: "hermes agent internals" }, 0),
      progress({ tool: "read", url: pageUrl("one") }, 0),
      progress({ tool: "read", url: pageUrl("one") }, 1),
      progress({ tool: "read", url: pageUrl("two") }, 1),
      progress({ tool: "read", url: pageUrl("two") }, 2),
      {
        type: "result",
        taskId: "task-1",
        spokenLine: goodAnswer.spokenLine,
        findings: {
          cardText: "## How it works\n\nHermes runs a loop with tools.",
          sources: [
            { id: "s1", url: pageUrl("one"), title: "Page one" },
            { id: "s2", url: pageUrl("two"), title: "Page two" },
          ],
          openPoints: goodAnswer.openPoints,
        },
      },
    ]);
    expect(run.queries).toEqual(["hermes agent internals"]);
    expect(run.loopRequests()).toHaveLength(4);
    expect(run.briefRequests()).toHaveLength(1);
  });
});

describe("runTask worker requests", () => {
  it("gives the worker the brief and only the search and read tools, behind a fixed prompt start", async () => {
    const run = await startRun(happySteps(), [hits(pageUrl("one"))]);
    run.port.send(runTask());
    await run.ended();
    const worker = run.workerRequests().slice(0, 4);
    const [first] = worker;
    const strictTool = (name: string, field: string) => ({
      name,
      strict: true,
      input_schema: { required: [field], additionalProperties: false },
    });
    expect(first.tools).toHaveLength(2);
    expect(first.tools).toMatchObject([
      strictTool("search", "query"),
      strictTool("read", "url"),
    ]);
    expect(first.tool_choice).toBeUndefined();
    expect(first.cache_control).toEqual({ type: "ephemeral" });
    expect(first.thinking).toEqual({ type: "between_tools" });
    expect(first.output_config?.effort).toBe("medium");
    expect(first.output_config?.format?.type).toBe("json_schema");
    expect(first.system).toContain(jsonOnlyLine);
    expect(first.system).not.toContain("2026-10-27");
    expect(first.messages).toHaveLength(1);
    expect(firstText(first)).toContain("Today's date: 2026-10-27.");
    expect(firstText(first)).toContain(`<goal>\n${brief.goal}\n</goal>`);
    expect(firstText(first)).toContain(brief.userWords);
    for (const request of worker) {
      expect(promptStart(request)).toBe(promptStart(first));
    }
  });
});

describe("runTask prompt start", () => {
  it("keeps the prompt start byte-identical between two tasks", async () => {
    const run = await startRun([
      { ok: false, failure: "error", detail: "x" },
      { ok: false, failure: "error", detail: "x" },
    ]);
    run.port.send(runTask());
    run.port.send(runTask({ taskId: "task-2" }));
    await run.settle(2);
    const [first, second] = run.workerRequests();
    expect(run.workerRequests()).toHaveLength(2);
    expect(promptStart(second)).toBe(promptStart(first));
  });

  it("only appends to the history, thinking blocks included", async () => {
    const run = await startRun(happySteps(), [hits(pageUrl("one"))]);
    run.port.send(runTask());
    await run.ended();
    const worker = run.workerRequests().slice(0, 4);
    for (const [step, request] of worker.entries()) {
      expect(request.messages).toHaveLength(1 + 2 * step);
      if (step === 0) continue;
      const before = worker[step - 1].messages;
      expect(request.messages.slice(0, before.length)).toEqual(before);
    }
    expect(worker[1].messages[1]).toMatchObject({
      role: "assistant",
      content: [thinkingBlock, { type: "tool_use", name: "search" }],
    });
  });
});

const parent: ParentResult = {
  taskId: "task-0",
  outcome: "done",
  findings: {
    cardText: "Hermes is an agent.",
    sources: [{ id: "s1", url: "https://hermes.example/docs", title: "Docs" }],
    openPoints: ["its memory"],
  },
};

const partialSentence = (ended: string) =>
  `The earlier task ended ${ended}, so its findings are partial and may not have been checked. Build on them, say near the top of the card text that this answer builds on a partial earlier result, and treat its points as unconfirmed until a page you read supports them.`;

const emptySentence = (ended: string) =>
  `The earlier task ended ${ended} before it found anything usable, so there is no earlier answer to build on. If this request depends on the earlier answer, do not search: use status "needsUser" and ask the user one question that would let you start. Only if the request is clear on its own, research it from the start and say near the top of the card text that the earlier task found nothing.`;

type FirstMessageRow = {
  name: string;
  parent: ParentResult | null;
  sentence: string | null;
};

const firstMessageRows: FirstMessageRow[] = [
  { name: "no parent", parent: null, sentence: null },
  { name: "a done parent", parent, sentence: null },
  ...(["incomplete", "cancelled"] as const).flatMap((outcome) => [
    {
      name: `an ${outcome} parent with findings`,
      parent: { ...parent, outcome },
      sentence: partialSentence(outcome),
    },
    {
      name: `an ${outcome} parent without findings`,
      parent: { ...parent, outcome, findings: null },
      sentence: emptySentence(outcome),
    },
  ]),
];

describe("runTask first message", () => {
  it.each(firstMessageRows)(
    "shows the parent block and its note for $name",
    async (row) => {
      const run = await startRun([
        { ok: false, failure: "error", detail: "x" },
      ]);
      run.port.send(runTask({ parent: row.parent }));
      await run.ended();
      const text = firstText(run.workerRequests()[0]);
      expect(text.includes("<parent_result>")).toBe(row.parent !== null);
      if (row.parent === null) return;
      if (row.sentence === null) {
        expect(text).not.toContain("so its findings are partial");
        expect(text).not.toContain("before it found anything usable");
      } else {
        expect(text).toContain(row.sentence);
      }
      if (row.parent.findings === null) {
        expect(text).toContain("No findings.");
        return;
      }
      expect(text).toContain("https://hermes.example/docs");
      expect(text).toContain("its memory");
      expect(text).toContain("read a page again before you cite it");
    },
  );
});
