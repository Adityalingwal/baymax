import type { Findings } from "../../../shared/cards";
import { hostOf } from "./url-host";
import type { ReadPage } from "./page-text";

// Page or model text on a card: one line, with every Markdown mark escaped, so it can never form a link or a block.
function markdownLine(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]()<>#!|~]/g, "\\$&");
}

// No id and no link: the Sources footer shows the clickable pages.
function pageLine(page: ReadPage): string {
  const label =
    page.title.trim() === "" ? (hostOf(page.url) ?? page.url) : page.title;
  return `- ${markdownLine(label)}`;
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
