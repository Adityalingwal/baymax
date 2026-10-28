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
  | { passed: true; findings: Findings; cited: ReadPage[] }
  | {
      passed: false;
      rule: CheckRule;
      uncheckedPart: string;
      findings: Findings;
    };

// A leftover source marker such as [s1] or [s1, s2], with the spaces before it, is removed; the card names no sources.
const marker = String.raw`[ \t]*\[\s*s\d+(?:\s*,\s*s\d+)*\s*\]`;

// One pass over model text: an escape pair stays as written, a marker goes,
// and every other bracket or autolink start is escaped, so no link, image or reference can form.
const cardToken = new RegExp(
  String.raw`\\[\s\S]|(${marker})|[[\]]|<[a-zA-Z][a-zA-Z0-9+.-]*:`,
  "gi",
);

function rewriteCard(cardText: string): string {
  return cardText
    .replace(cardToken, (token, found: string | undefined) => {
      if (token.startsWith("\\")) return token;
      return found === undefined ? `\\${token}` : "";
    })
    .trim();
}

// The card's sources come only from the claims' ids.
const citedIds = (answer: Answer) =>
  answer.claims.flatMap((claim) => claim.sourceIds);

function failedRule(answer: Answer, pages: ReadPage[]): CheckRule | null {
  if (answer.spokenLine.trim() === "" || answer.cardText.trim() === "") {
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

function built(answer: Answer, pages: ReadPage[]) {
  const ids = new Set(citedIds(answer));
  const cited = pages.filter((page) => ids.has(page.id));
  const findings: Findings = {
    cardText: rewriteCard(answer.cardText),
    sources: cited.map(({ id, url, title }) => ({ id, url, title })),
    openPoints: answer.openPoints,
  };
  return { cited, findings };
}

// The card as the user may see it, built in code whether or not the answer passes: plain text, no links.
export function answerFindings(answer: Answer, pages: ReadPage[]): Findings {
  return built(answer, pages).findings;
}

export function checkAnswer(answer: Answer, pages: ReadPage[]): CodeCheck {
  const { cited, findings } = built(answer, pages);
  const rule = failedRule(answer, pages);
  return rule === null
    ? { passed: true, findings, cited }
    : { passed: false, rule, uncheckedPart: rules[rule], findings };
}
