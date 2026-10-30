import type { SearchHit } from "../../../providers/exa";
import type { Findings } from "../../../shared/cards";
import type { ParentResult } from "../../../shared/engine";
import { escapeText, taggedText } from "../../../providers/tagged-text";
import type { ReadPage } from "./page-text";

const snippetNote =
  "These are search snippets, not read pages, and cannot be cited; read a URL to cite it.";

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

export function pageForModel(page: ReadPage): string {
  return [
    `<page source_id="${escapeAttribute(page.id)}" url="${escapeAttribute(page.url)}">`,
    `title: ${escapeText(page.title)}`,
    "",
    escapeText(page.text),
    "</page>",
  ].join("\n");
}

export function searchHitsForModel(hits: SearchHit[]): string {
  const listed = hits.map((hit) =>
    [
      `title: ${escapeText(hit.title)}`,
      `url: ${escapeText(hit.url)}`,
      `snippet: ${escapeText(hit.snippet)}`,
    ].join("\n"),
  );
  return ["<search_results>", snippetNote, ...listed, "</search_results>"].join(
    "\n\n",
  );
}

function findingsLines(findings: Findings | null): string[] {
  if (findings === null) return ["No findings."];
  const sources = findings.sources.map(
    (source) => `- ${source.id} ${source.url} | ${source.title}`,
  );
  return [
    taggedText("card_text", findings.cardText),
    taggedText("sources", sources.join("\n") || "none"),
  ];
}

export function parentResultBlock(parent: ParentResult): string {
  const { goal, spokenLine } = parent;
  const lines = [
    `outcome: ${parent.outcome}`,
    ...(goal === null ? [] : [taggedText("goal", goal)]),
    taggedText("words", parent.words),
    ...(spokenLine === null ? [] : [taggedText("line", spokenLine)]),
    ...findingsLines(parent.findings),
  ];
  return `<parent_result>\n${lines.join("\n")}\n</parent_result>`;
}
