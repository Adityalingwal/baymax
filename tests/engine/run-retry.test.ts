import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome, ModelRequest } from "../../src/providers/anthropic";
import type { Findings } from "../../src/shared/cards";
import { fakeMessage } from "./harness";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  failed,
  goodAnswer,
  hits,
  pageUrl,
  runTask,
  startRun,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const goodFindings: Findings = {
  cardText: "## How it works\n\nHermes runs a loop with tools.",
  sources: [
    { id: "s1", url: pageUrl("one"), title: "Page one" },
    { id: "s2", url: pageUrl("two"), title: "Page two" },
  ],
};

const reading: FakeStep[] = [
  toolUseReply([{ search: "hermes" }]),
  toolUseReply([{ read: pageUrl("one") }]),
  toolUseReply([{ read: pageUrl("two") }]),
];

const search = [hits(pageUrl("one"), pageUrl("two"))];

const rewriteLine =
  "Your answer did not pass the check above. Write the whole answer again as the JSON object, fixing that part. In sourceIds, name only pages you read.";

const answerText = (text: string, cut = false): ModelOutcome => ({
  ok: true,
  message: fakeMessage(text, { stopReason: cut ? "max_tokens" : "end_turn" }),
});

const onlyUnread = () => workerAnswer({ sourceIds: ["s9"] });

const empty = { report: "", line: "", sourceIds: [] };

type RewriteRow = {
  name: string;
  bad: ModelOutcome; // the first answer turn
  fault: string; // what the check_result block says
};

const nothingFoundFault =
  "nothingFound must be null unless you found nothing, and then it is one plain sentence with the report and the line empty.";

const noSourcesFault =
  "sourceIds named no page you read. Name the read pages that back your answer, and read one first if you have read none.";

const rewriteRows: RewriteRow[] = [
  {
    name: "an answer naming only unread pages",
    bad: onlyUnread(),
    fault: noSourcesFault,
  },
  {
    name: "an answer with no source ids",
    bad: workerAnswer({ sourceIds: [] }),
    fault: noSourcesFault,
  },
  {
    name: "an empty line",
    bad: workerAnswer({ line: "  " }),
    fault: "The line was empty. Write it.",
  },
  {
    name: "nothingFound beside a line and a report",
    bad: workerAnswer({ nothingFound: "Nothing helped." }),
    fault: nothingFoundFault,
  },
  {
    name: "nothingFound beside a report only",
    bad: workerAnswer({ line: "", nothingFound: "Nothing helped." }),
    fault: nothingFoundFault,
  },
  {
    name: "a blank nothingFound",
    bad: workerAnswer({ ...empty, nothingFound: " " }),
    fault: nothingFoundFault,
  },
  {
    name: "malformed answer JSON",
    bad: answerText("{ not json"),
    fault: "The answer was not valid JSON for the schema.",
  },
  {
    name: "an answer cut at max_tokens",
    bad: answerText(JSON.stringify(goodAnswer), true),
    fault:
      "The answer was cut off at the length limit. Write a shorter report.",
  },
];

const promptStart = (request: ModelRequest) =>
  JSON.stringify([request.system, request.tools, request.cache_control]);

const contentOf = (step: ModelOutcome) => (step.ok ? step.message.content : []);

describe("runTask one rewrite", () => {
  it.each(rewriteRows)(
    "answers again after $name, with its fault named",
    async (row) => {
      const run = await startRun([...reading, row.bad, workerAnswer()], search);
      run.port.send(runTask());
      const events = await run.ended();
      expect(events.filter((event) => event.type !== "progress")).toEqual([
        {
          type: "result",
          taskId: "task-1",
          spokenLine: goodAnswer.line,
          findings: goodFindings,
        },
      ]);
      const asked = run.requests[3];
      const rewrite = run.requests[4];
      expect(rewrite.messages).toEqual([
        ...asked.messages,
        { role: "assistant", content: contentOf(row.bad) },
        {
          role: "user",
          content: `<check_result>\n${row.fault}\n</check_result>\n\n${rewriteLine}`,
        },
      ]);
      expect(promptStart(rewrite)).toBe(promptStart(run.requests[0]));
    },
  );
});

describe("runTask after a bad answer", () => {
  it("lets the rewrite read a page first when none was read", async () => {
    const run = await startRun([
      workerAnswer({ sourceIds: ["s1"] }),
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer({ sourceIds: ["s1"] }),
    ]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.at(-1)).toMatchObject({
      type: "result",
      findings: { sources: [{ id: "s1" }] },
    });
  });

  it("ends failed with the pages read after a second bad answer, never asking for a third", async () => {
    const run = await startRun(
      [...reading, onlyUnread(), onlyUnread()],
      search,
    );
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      failed("error", {
        cardText: "- Page one\n- Page two",
        sources: goodFindings.sources,
      }),
    ]);
    expect(run.requests).toHaveLength(5);
  });
});
