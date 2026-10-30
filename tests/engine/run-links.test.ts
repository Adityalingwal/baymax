import { afterEach, describe, expect, it } from "vitest";
import {
  closeRuns,
  pageUrl,
  runTask,
  startRun,
  strayLinks,
  toolUseReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const unread = "https://unread.example/docs";
const claimOne = [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }];

type Row = { name: string; page: string; cardText: string; expected: string };

const rows: Row[] = [
  {
    name: "a link with a nested label",
    page: "one",
    cardText: `A loop, see [see [details]](${unread}).`,
    expected: `A loop, see \\[see \\[details\\]\\](${unread}).`,
  },
  {
    name: "an image",
    page: "one",
    cardText: `A loop ![x](${unread}/x.png)`,
    expected: `A loop !\\[x\\](${unread}/x.png)`,
  },
  {
    name: "an autolink",
    page: "one",
    cardText: `A loop at <${unread}> or <mailto:a@b.example>.`,
    expected: `A loop at \\<${unread}> or \\<mailto:a@b.example>.`,
  },
  {
    name: "a reference definition and its use",
    page: "one",
    cardText: `A loop in [the docs][d].\n\n  [d]: ${unread}`,
    expected: `A loop in \\[the docs\\]\\[d\\].\n\n  \\[d\\]: ${unread}`,
  },
  {
    name: "a definition in a block quote",
    page: "one",
    cardText: `A loop in [docs][x].\n\n> [x]: ${unread}`,
    expected: `A loop in \\[docs\\]\\[x\\].\n\n> \\[x\\]: ${unread}`,
  },
  {
    name: "a definition in a list item",
    page: "one",
    cardText: `A loop in [docs][x].\n\n- [x]: ${unread}`,
    expected: `A loop in \\[docs\\]\\[x\\].\n\n- \\[x\\]: ${unread}`,
  },
  {
    name: "a full reference link",
    page: "one",
    cardText: `A loop, see [a][b].\n\n[b]: ${unread}`,
    expected: `A loop, see \\[a\\]\\[b\\].\n\n\\[b\\]: ${unread}`,
  },
  {
    name: "a collapsed reference link",
    page: "one",
    cardText: `A loop, see [a][].\n\n[a]: ${unread}`,
    expected: `A loop, see \\[a\\]\\[\\].\n\n\\[a\\]: ${unread}`,
  },
  {
    name: "a marker inside brackets",
    page: "one",
    cardText: "A loop [[s1]].",
    expected: `A loop \\[\\].`,
  },
  {
    name: "a model-written link to a read page",
    page: "one",
    cardText: `A loop, see [the docs](${pageUrl("one")}).`,
    expected: `A loop, see \\[the docs\\](${pageUrl("one")}).`,
  },
  // Source markers leave the card; an escaped bracket pair stays as written.
  ...[
    ["A loop [s1].", "A loop."],
    ["31°C [s1][s3].", "31°C."],
    ["[s1] First", "First"],
    ["Fact [S1] here", "Fact here"],
    ["Fact [s1, s2] here", "Fact here"],
    ["Kept \\[s1\\] pair", "Kept \\[s1\\] pair"],
  ].map(([cardText, expected]) => ({
    name: `the markers of ${JSON.stringify(cardText)}`,
    page: "one",
    cardText,
    expected,
  })),
  {
    name: "a marker inside an autolink",
    page: "one",
    cardText: `A loop, see <[s1]${unread}>.`,
    expected: `A loop, see \\<${unread}>.`,
  },
];

describe("runTask card links", () => {
  it.each(rows)("forms no link of any kind after $name", async (row) => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl(row.page) }]),
      workerAnswer({ cardText: row.cardText, claims: claimOne }),
    ]);
    run.port.send(runTask());
    const events = await run.ended();
    const last = events[events.length - 1];
    if (last.type !== "result") throw new Error(`ended ${last.type}`);
    expect(last.findings.cardText).toBe(row.expected);
    expect(last.findings.sources).toEqual([
      { id: "s1", url: pageUrl(row.page), title: `Page ${row.page}` },
    ]);
    expect(strayLinks(last.findings)).toEqual([]);
    expect(last.findings.cardText).not.toContain("](<");
    expect(last.findings.cardText).not.toMatch(/(?<!\\)<[a-z][a-z0-9+.-]*:/i);
  });
});
