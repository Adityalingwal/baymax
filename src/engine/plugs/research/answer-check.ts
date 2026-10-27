import type { Findings } from "../../../shared/cards";
import type { Answer } from "./answer";
import type { ReadPage } from "./page-text";

// The research plug's done condition in code: the first failed rule wins, and its part is named in plain words.
const rules = {
  emptyText: "an empty spoken line or card text",
  claimWithoutSource: "claims without a source",
  noCitation: "a card with no citations",
  unreadCitation: "citations to pages that were not read",
} as const;

type CheckRule = keyof typeof rules;

export type CodeCheck =
  | { passed: true; findings: Findings; cited: ReadPage[] }
  | {
      passed: false;
      rule: CheckRule;
      uncheckedPart: string;
      findings: Findings;
    };

// One pass over model text: an escape pair stays as written, a marker such as [s1] is kept for code,
// and every other bracket or autolink start is escaped, so no link, image or reference can form.
const cardToken = /\\[\s\S]|\[(s\d+)\]|[[\]]|<[a-zA-Z][a-zA-Z0-9+.-]*:/g;

function markersIn(cardText: string): string[] {
  return [...cardText.matchAll(cardToken)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

// Read URLs are serialized URLs, so an angle-bracket destination holds them, parentheses included.
export const linkable = (url: string) => !/[<>\s]/.test(url);

// Only code writes links: a marker for a read page becomes one, a marker for a page not read is dropped.
function rewriteCard(cardText: string, pages: ReadPage[]): string {
  const byId = new Map(pages.map((page) => [page.id, page.url]));
  return cardText.replace(cardToken, (token, id: string | undefined) => {
    if (token.startsWith("\\")) return token;
    if (id === undefined) return `\\${token}`;
    const url = byId.get(id);
    if (url === undefined) return "";
    return linkable(url) ? `[${id}](<${url}>)` : `\\[${id}\\]`;
  });
}

function citedIds(answer: Answer, markerIds: string[]): string[] {
  return [...answer.claims.flatMap((claim) => claim.sourceIds), ...markerIds];
}

function failedRule(
  answer: Answer,
  markerIds: string[],
  pages: ReadPage[],
): CheckRule | null {
  if (answer.spokenLine.trim() === "" || answer.cardText.trim() === "") {
    return "emptyText";
  }
  const { claims } = answer;
  if (claims.length === 0 || claims.some((c) => c.sourceIds.length === 0)) {
    return "claimWithoutSource";
  }
  if (markerIds.length === 0) return "noCitation";
  const readIds = new Set(pages.map((page) => page.id));
  const ids = citedIds(answer, markerIds);
  return ids.every((id) => readIds.has(id)) ? null : "unreadCitation";
}

function built(answer: Answer, pages: ReadPage[]) {
  const cardText = answer.cardText.trim();
  const markerIds = markersIn(cardText);
  const ids = new Set(citedIds(answer, markerIds));
  const cited = pages.filter((page) => ids.has(page.id));
  const findings: Findings = {
    cardText: rewriteCard(cardText, pages),
    sources: cited.map(({ id, url, title }) => ({ id, url, title })),
    openPoints: answer.openPoints,
  };
  return { markerIds, cited, findings };
}

// The card as the user may see it, built in code whether or not the answer passes: links only to cited read pages.
export function answerFindings(answer: Answer, pages: ReadPage[]): Findings {
  return built(answer, pages).findings;
}

export function checkAnswer(answer: Answer, pages: ReadPage[]): CodeCheck {
  const { markerIds, cited, findings } = built(answer, pages);
  const rule = failedRule(answer, markerIds, pages);
  return rule === null
    ? { passed: true, findings, cited }
    : { passed: false, rule, uncheckedPart: rules[rule], findings };
}
