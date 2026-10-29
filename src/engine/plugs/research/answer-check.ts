import type { Findings } from "../../../shared/cards";
import type { Answer } from "./answer";
import type { ReadPage } from "./page-text";

// The research plug's done condition in code: the first failed rule wins, and its part is named in plain words.
const rules = {
  emptyText: "an empty spoken line or card text",
  claimWithoutSource: "claims without a source",
  unreadCitation: "citations to pages that were not read",
} as const;

type CheckRule = keyof typeof rules;

export type CodeCheck =
  | { passed: true; findings: Findings }
  | {
      passed: false;
      rule: CheckRule;
      uncheckedPart: string;
      findings: Findings;
    };

// A leftover source marker such as [s1] or [s1, s2], with the spaces before it, is removed; the card names no sources.
const marker = String.raw`[ \t]*\[\s*s\d+(?:\s*,\s*s\d+)*\s*\]`;

const markerToken = new RegExp(String.raw`\\[\s\S]|${marker}`, "gi");

// Every bracket or autolink start is escaped, so no link, image or reference can form; an escape pair stays as written.
const escapeToken = /\\[\s\S]|[[\]]|<[a-zA-Z][a-zA-Z0-9+.-]*:/g;

// Two passes, so removing a marker can never join text into a link: markers go first, then the escape pass runs on what is left.
function rewriteCard(cardText: string): string {
  const unmarked = cardText.replace(markerToken, (token) =>
    token.startsWith("\\") ? token : "",
  );
  return unmarked
    .replace(escapeToken, (token) =>
      token.startsWith("\\") ? token : `\\${token}`,
    )
    .trim();
}

// The card's sources come only from the claims' ids.
const citedIds = (answer: Answer) =>
  answer.claims.flatMap((claim) => claim.sourceIds);

// The card text is the built one, as the user sees it: a card of only markers is empty.
function failedRule(
  answer: Answer,
  cardText: string,
  pages: ReadPage[],
): CheckRule | null {
  if (answer.spokenLine.trim() === "" || cardText === "") {
    return "emptyText";
  }
  const { claims } = answer;
  if (claims.length === 0 || claims.some((c) => c.sourceIds.length === 0)) {
    return "claimWithoutSource";
  }
  const readIds = new Set(pages.map((page) => page.id));
  return citedIds(answer).every((id) => readIds.has(id))
    ? null
    : "unreadCitation";
}

// The card as the user may see it, built in code whether or not the answer passes: plain text, no links.
export function answerFindings(answer: Answer, pages: ReadPage[]): Findings {
  const ids = new Set(citedIds(answer));
  const cited = pages.filter((page) => ids.has(page.id));
  return {
    cardText: rewriteCard(answer.cardText),
    sources: cited.map(({ id, url, title }) => ({ id, url, title })),
    openPoints: answer.openPoints,
  };
}

export function checkAnswer(answer: Answer, pages: ReadPage[]): CodeCheck {
  const findings = answerFindings(answer, pages);
  const rule = failedRule(answer, findings.cardText, pages);
  return rule === null
    ? { passed: true, findings }
    : { passed: false, rule, uncheckedPart: rules[rule], findings };
}
