import type { Findings } from "../../../shared/cards";
import { linkable } from "./answer-check";
import type { ReadPage } from "./page-text";

// A page title is page text: one line, with every Markdown mark escaped, so it can never form a link or a block.
function titleLine(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]()<>#!|~]/g, "\\$&");
}

function pageLine(page: ReadPage): string {
  const label = linkable(page.url) ? `[${page.id}](<${page.url}>)` : page.id;
  return `- ${label} ${titleLine(page.title)}`.trimEnd();
}

function pageList(pages: ReadPage[]): Findings {
  return {
    cardText: pages.map(pageLine).join("\n"),
    sources: pages.map(({ id, url, title }) => ({ id, url, title })),
    openPoints: [],
  };
}

// What a run that ended short found: its latest built answer with text, else the pages it read, else nothing.
export function foundFindings(
  answer: Findings | null,
  pages: ReadPage[],
): Findings | null {
  if (answer !== null && answer.cardText.trim() !== "") return answer;
  return pages.length === 0 ? null : pageList(pages);
}
