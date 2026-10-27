import { afterEach, describe, expect, it } from "vitest";
import {
  closeRuns,
  pageUrl,
  runTask,
  startRun,
  strayLinks,
  toolUseReply,
  verdictReply,
  workerAnswer,
} from "./run.harness";

afterEach(closeRuns);

const unread = "https://unread.example/docs";
const claimOne = [{ claim: "Hermes runs a loop", sourceIds: ["s1"] }];
const marker = (name: string) => `[s1](<${pageUrl(name)}>)`;

type Row = { name: string; page: string; cardText: string; expected: string };

const rows: Row[] = [
  {
    name: "a link with a nested label",
    page: "one",
    cardText: `A loop [s1], see [see [details]](${unread}).`,
    expected: `A loop ${marker("one")}, see \\[see \\[details\\]\\](${unread}).`,
  },
  {
    name: "an image",
    page: "one",
    cardText: `A loop [s1] ![x](${unread}/x.png)`,
    expected: `A loop ${marker("one")} !\\[x\\](${unread}/x.png)`,
  },
  {
    name: "an autolink",
    page: "one",
    cardText: `A loop [s1] at <${unread}> or <mailto:a@b.example>.`,
    expected: `A loop ${marker("one")} at \\<${unread}> or \\<mailto:a@b.example>.`,
  },
  {
    name: "a reference definition and its use",
    page: "one",
    cardText: `A loop [s1] in [the docs][d].\n\n  [d]: ${unread}`,
    expected: `A loop ${marker("one")} in \\[the docs\\]\\[d\\].\n\n  \\[d\\]: ${unread}`,
  },
  {
    name: "a definition in a block quote",
    page: "one",
    cardText: `A loop [s1] in [docs][x].\n\n> [x]: ${unread}`,
    expected: `A loop ${marker("one")} in \\[docs\\]\\[x\\].\n\n> \\[x\\]: ${unread}`,
  },
  {
    name: "a definition in a list item",
    page: "one",
    cardText: `A loop [s1] in [docs][x].\n\n- [x]: ${unread}`,
    expected: `A loop ${marker("one")} in \\[docs\\]\\[x\\].\n\n- \\[x\\]: ${unread}`,
  },
  {
    name: "a full reference link",
    page: "one",
    cardText: `A loop [s1], see [a][b].\n\n[b]: ${unread}`,
    expected: `A loop ${marker("one")}, see \\[a\\]\\[b\\].\n\n\\[b\\]: ${unread}`,
  },
  {
    name: "a collapsed reference link",
    page: "one",
    cardText: `A loop [s1], see [a][].\n\n[a]: ${unread}`,
    expected: `A loop ${marker("one")}, see \\[a\\]\\[\\].\n\n\\[a\\]: ${unread}`,
  },
  {
    name: "a marker inside brackets",
    page: "one",
    cardText: "A loop [[s1]].",
    expected: `A loop \\[${marker("one")}\\].`,
  },
  {
    name: "a model-written link to a read page",
    page: "one",
    cardText: `A loop [s1], see [the docs](${pageUrl("one")}).`,
    expected: `A loop ${marker("one")}, see \\[the docs\\](${pageUrl("one")}).`,
  },
  {
    name: "a read URL with parentheses",
    page: "paren(1)",
    cardText: "A loop [s1].",
    expected: `A loop ${marker("paren(1)")}.`,
  },
];

describe("runTask card links", () => {
  it.each(rows)("leaves only marker links after $name", async (row) => {
    const run = await startRun([
      toolUseReply([{ read: pageUrl(row.page) }]),
      workerAnswer({ cardText: row.cardText, claims: claimOne }),
      verdictReply(),
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
    expect(last.findings.cardText).not.toMatch(
      /(?<!\\)<[a-z][a-z0-9+.-]*:(?!\/\/example\.test)/i,
    );
  });
});
