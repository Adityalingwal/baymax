import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../../src/providers/anthropic";
import type { Findings } from "../../src/shared/cards";
import type { EngineEvent } from "../../src/shared/engine";
import { fakeMessage } from "./harness";
import type { FakeStep } from "./harness";
import {
  closeRuns,
  failed,
  hits,
  pageUrl,
  runTask,
  startRun,
  strayLinks,
  toolUseReply,
  workerAnswer,
} from "./run.harness";
import { htmlPage, sendRoute } from "./plugs/research/fake-network";

afterEach(closeRuns);

// A call whose reported usage leaves no room for the next one, so the run ends limitHit there.
function costly(step: ModelOutcome): ModelOutcome {
  if (step.ok) step.message.usage.input_tokens = 430_000;
  return step;
}

// The last answer failed too, so the task ends with what it found.
const lastFails = (): ModelOutcome => ({
  ok: false,
  failure: "error",
  detail: "x",
});

const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const two = { id: "s2", url: pageUrl("two"), title: "Page two" };

type FoundRow = {
  name: string;
  steps: () => FakeStep[];
  found: Findings | null;
};

const listOne: Findings = {
  cardText: "- Page one",
  sources: [one],
};

const foundRows: FoundRow[] = [
  {
    name: "nothing when no page was read",
    steps: () => [costly(toolUseReply([{ search: "hermes" }]))],
    found: null,
  },
  {
    name: "the read pages when no answer was built",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      costly(toolUseReply([{ read: pageUrl("two") }])),
      lastFails(),
    ],
    found: {
      cardText: "- Page one\n- Page two",
      sources: [one, two],
    },
  },
  {
    name: "only the read pages, never the report of an answer rejected for its line",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      costly(workerAnswer({ line: " ", sourceIds: ["s1"] })),
      lastFails(),
    ],
    found: listOne,
  },
  {
    name: "only the read pages, never the report of an answer rejected for its ids",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      costly(workerAnswer({ sourceIds: ["s9"] })),
      lastFails(),
    ],
    found: listOne,
  },
];

describe("runTask what was found at a limit", () => {
  it.each(foundRows)("ends failed with $name", async (row) => {
    const run = await startRun(row.steps(), [hits(pageUrl("one"))]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      failed("limitHit", row.found),
    ]);
  });
});

const answerText = (text: string, cut = false): ModelOutcome => ({
  ok: true,
  message: fakeMessage(text, { stopReason: cut ? "max_tokens" : "end_turn" }),
});
const notJson = () => answerText("{ not json");
const cutOff = () => answerText(JSON.stringify({ report: "A long" }), true);

// Handled here so it only rejects where the engine awaits it.
function thrown(): Promise<ModelOutcome> {
  const call = Promise.reject(new Error("boom"));
  call.catch(() => undefined);
  return call;
}

type EndRow = { name: string; steps: () => FakeStep[]; ending: EngineEvent };

const readOne = () => toolUseReply([{ read: pageUrl("one") }]);

const endRows: EndRow[] = [
  {
    name: "a malformed answer twice after a read",
    steps: () => [readOne(), notJson(), notJson()],
    ending: failed("error", listOne),
  },
  {
    name: "a cut-off answer twice after a read",
    steps: () => [readOne(), cutOff(), cutOff()],
    ending: failed("error", listOne),
  },
  {
    name: "an invalid answer, then a malformed one",
    steps: () => [readOne(), workerAnswer({ line: "" }), notJson()],
    ending: failed("error", listOne),
  },
  {
    name: "a thrown run after a read",
    steps: () => [readOne(), thrown()],
    ending: failed("error", listOne),
  },
  {
    name: "a rejected search key after a read",
    steps: () => [readOne(), toolUseReply([{ search: "hermes" }])],
    ending: failed("searchKeyRejected", listOne),
  },
];

describe("runTask other short endings", () => {
  it.each(endRows)("ends $name with what was found", async (row) => {
    const run = await startRun(row.steps(), [
      { ok: false, cause: "keyRejected" },
    ]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      row.ending,
    ]);
  });
});

const titles = [
  "[s2](https://evil.example/a) and [s2]",
  "[d]: https://evil.example/b",
  "&lt;https://evil.example/c&gt; &amp; ![x](y) *a* _b_ `c` # d | e ~ f \\",
];

const escapedTitles = [
  "\\[s2\\]\\(https://evil.example/a\\) and \\[s2\\]",
  "\\[d\\]: https://evil.example/b",
  "\\<https://evil.example/c\\> & \\!\\[x\\]\\(y\\) \\*a\\* \\_b\\_ \\`c\\` \\# d \\| e \\~ f \\\\",
];

describe("runTask page list", () => {
  it("escapes page titles so no link or autolink can form", async () => {
    const run = await startRun([
      toolUseReply(titles.map((_, index) => ({ read: pageUrl(`t${index}`) }))),
      costly(toolUseReply([{ read: pageUrl("one") }])),
      lastFails(),
    ]);
    const words = "Plain words for a reader to keep. ".repeat(10);
    for (const [index, title] of titles.entries()) {
      const body = htmlPage(title, `<p>${words}</p>`);
      const headers = { "Content-Type": "text/html" };
      run.network.route(`/t${index}`, sendRoute({ headers, body }));
    }
    run.port.send(runTask());
    const events = await run.ended();
    const last = events[events.length - 1];
    if (last.type !== "failed") throw new Error(`ended ${last.type}`);
    const { findings } = last;
    if (findings === null) throw new Error("no findings");
    const lines = findings.cardText.split("\n");
    const ids = findings.sources.map((source) => source.id);
    expect(ids).toEqual(["s1", "s2", "s3", "s4"]);
    for (const escaped of escapedTitles) {
      expect(lines).toContain(`- ${escaped}`);
    }
    expect(strayLinks(findings)).toEqual([]);
    // An autolink would be "<scheme:" with no backslash before it.
    expect(findings.cardText).not.toMatch(/(?<!\\)<[a-z][a-z0-9+.-]*:/i);
  });
});
