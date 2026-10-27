import { afterEach, describe, expect, it } from "vitest";
import type { Findings } from "../shared/cards";
import {
  closeRuns,
  pageUrl,
  runTask,
  startRun,
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
    expected: `A loop ${marker("one")}, see [see [details]]\\(${unread}).`,
  },
  {
    name: "an image",
    page: "one",
    cardText: `A loop [s1] ![x](${unread}/x.png)`,
    expected: `A loop ${marker("one")} ![x]\\(${unread}/x.png)`,
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
    expected: `A loop ${marker("one")} in [the docs][d].\n\n  \\[d]: ${unread}`,
  },
  {
    name: "a model-written link to a read page",
    page: "one",
    cardText: `A loop [s1], see [the docs](${pageUrl("one")}).`,
    expected: `A loop ${marker("one")}, see [the docs]\\(${pageUrl("one")}).`,
  },
  {
    name: "a read URL with parentheses",
    page: "paren(1)",
    cardText: "A loop [s1].",
    expected: `A loop ${marker("paren(1)")}.`,
  },
];

// Every unescaped "](" must open a marker link to one of the sources, in angle brackets.
function linksOutside(findings: Findings): string[] {
  const urls = findings.sources.map((source) => source.url);
  return [...findings.cardText.matchAll(/(?<!\\)\]\(/g)].flatMap((match) => {
    const rest = findings.cardText.slice((match.index ?? 0) + 2);
    return urls.some((url) => rest.startsWith(`<${url}>)`)) ? [] : [rest];
  });
}

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
    expect(linksOutside(last.findings)).toEqual([]);
    expect(last.findings.cardText).not.toMatch(
      /(?<!\\)<[a-z][a-z0-9+.-]*:(?!\/\/example\.test)/i,
    );
  });
});
