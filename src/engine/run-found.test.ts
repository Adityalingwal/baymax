import { afterEach, describe, expect, it } from "vitest";
import type { ModelOutcome } from "../providers/anthropic";
import type { Findings } from "../shared/cards";
import type { Incomplete } from "../shared/engine";
import { fakeMessage } from "./harness";
import type { FakeStep } from "./harness";
import {
  closeRuns,
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
  if (step.ok) step.message.usage.input_tokens = 248_000;
  return step;
}

const link = (id: string, name: string) => `[${id}](<${pageUrl(name)}>)`;
const one = { id: "s1", url: pageUrl("one"), title: "Page one" };
const two = { id: "s2", url: pageUrl("two"), title: "Page two" };
const claimOne = [{ claim: "A loop", sourceIds: ["s1"] }];

type FoundRow = {
  name: string;
  steps: () => FakeStep[];
  found: Findings | null;
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
    ],
    found: {
      cardText: `- ${link("s1", "one")} Page one\n- ${link("s2", "two")} Page two`,
      sources: [one, two],
      openPoints: [],
    },
  },
  {
    name: "the failed first answer's card, unread markers dropped",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      costly(
        workerAnswer({
          cardText: "A loop [s1] and memory [s7].",
          claims: claimOne,
        }),
      ),
    ],
    found: {
      cardText: `A loop ${link("s1", "one")} and memory .`,
      sources: [one],
      openPoints: ["How it stores memory"],
    },
  },
  {
    name: "the read pages after an empty failed answer",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      costly(workerAnswer({ cardText: " ", claims: claimOne })),
    ],
    found: {
      cardText: `- ${link("s1", "one")} Page one`,
      sources: [one],
      openPoints: [],
    },
  },
];

describe("runTask what was found", () => {
  it.each(foundRows)("ends limitHit with $name", async (row) => {
    const run = await startRun(row.steps(), [hits(pageUrl("one"))]);
    run.port.send(runTask());
    const events = await run.ended();
    expect(events.filter((event) => event.type !== "progress")).toEqual([
      {
        type: "incomplete",
        taskId: "task-1",
        incomplete: { kind: "limitHit", findings: row.found },
      },
    ]);
  });
});

const listOne: Findings = {
  cardText: `- ${link("s1", "one")} Page one`,
  sources: [one],
  openPoints: [],
};
const unreadCard: Findings = {
  cardText: `A loop ${link("s1", "one")} and memory .`,
  sources: [one],
  openPoints: ["How it stores memory"],
};
const answerText = (text: string, cut = false): ModelOutcome => ({
  ok: true,
  message: fakeMessage(text, { stopReason: cut ? "max_tokens" : "end_turn" }),
});
const notJson = () => answerText("{ not json");
const cutOff = () => answerText(JSON.stringify({ cardText: "A long" }), true);

// Handled here so it only rejects where the engine awaits it.
function thrown(): Promise<ModelOutcome> {
  const call = Promise.reject(new Error("boom"));
  call.catch(() => undefined);
  return call;
}

type EndRow = { name: string; steps: () => FakeStep[]; ending: Incomplete };

const wholeAnswer = (findings: Findings): Incomplete => ({
  kind: "unchecked",
  uncheckedPart: "the whole answer",
  findings,
});

const endRows: EndRow[] = [
  {
    name: "two malformed answers after a read",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      notJson(),
      notJson(),
    ],
    ending: wholeAnswer(listOne),
  },
  {
    name: "two cut-off answers after a read",
    steps: () => [toolUseReply([{ read: pageUrl("one") }]), cutOff(), cutOff()],
    ending: wholeAnswer(listOne),
  },
  {
    name: "a failed answer, then a malformed one",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      workerAnswer({
        cardText: "A loop [s1] and memory [s7].",
        claims: claimOne,
      }),
      notJson(),
    ],
    ending: wholeAnswer(unreadCard),
  },
  {
    name: "a thrown run after a read",
    steps: () => [toolUseReply([{ read: pageUrl("one") }]), thrown()],
    ending: { kind: "error", cause: "error", findings: listOne },
  },
  {
    name: "a search that is down after a read",
    steps: () => [
      toolUseReply([{ read: pageUrl("one") }]),
      toolUseReply([{ search: "hermes" }]),
    ],
    ending: { kind: "error", cause: "searchDown", findings: listOne },
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
      { type: "incomplete", taskId: "task-1", incomplete: row.ending },
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
  it("escapes page titles so only the code's links remain", async () => {
    const run = await startRun([
      toolUseReply(titles.map((_, index) => ({ read: pageUrl(`t${index}`) }))),
      costly(toolUseReply([{ read: pageUrl("one") }])),
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
    if (last.type !== "incomplete") throw new Error(`ended ${last.type}`);
    const { findings } = last.incomplete;
    if (findings === null) throw new Error("no findings");
    const lines = findings.cardText.split("\n");
    const ids = findings.sources.map((source) => source.id);
    expect(ids).toEqual(["s1", "s2", "s3", "s4"]);
    for (const [index, escaped] of escapedTitles.entries()) {
      const url = findings.sources[index].url;
      expect(lines).toContain(`- [s${index + 1}](<${url}>) ${escaped}`);
    }
    expect(strayLinks(findings)).toEqual([]);
    // An autolink would be "<scheme:" not escaped and not the code's own "](<" destination.
    expect(findings.cardText).not.toMatch(/(?<![\\(])<[a-z][a-z0-9+.-]*:/i);
  });
});
