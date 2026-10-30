import type { SearchHit } from "../../../providers/exa";
import type { Findings } from "../../../shared/cards";
import type { ParentResult } from "../../../shared/engine";
import type { ReadPage } from "./page-text";

// Page text and snippets are untrusted: escaping keeps them from closing or opening a block.

const snippetNote =
  "These are search snippets, not read pages, and cannot be cited; read a URL to cite it.";

function escapeText(text: string): string {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

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

// Escaped text in one tagged block, so user or model text cannot close or open a block either.
export function taggedText(tag: string, text: string): string {
  return `<${tag}>\n${escapeText(text)}\n</${tag}>`;
}

function findingsLines(findings: Findings | null): string[] {
  if (findings === null) return ["No findings."];
  const sources = findings.sources.map(
    (source) => `- ${source.id} ${source.url} | ${source.title}`,
  );
  const open = findings.openPoints.map((point) => `- ${point}`);
  return [
    taggedText("card_text", findings.cardText),
    taggedText("sources", sources.join("\n") || "none"),
    taggedText("open_points", open.join("\n") || "none"),
  ];
}

// What an earlier task left, for the brief writer and the worker alike.
export function parentResultBlock(parent: ParentResult): string {
  const lines = [
    `outcome: ${parent.outcome}`,
    ...findingsLines(parent.findings),
  ];
  return `<parent_result>\n${lines.join("\n")}\n</parent_result>`;
}
