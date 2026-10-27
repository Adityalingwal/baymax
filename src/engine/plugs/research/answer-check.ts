import type { Findings } from "../../../shared/cards";
import type { Answer } from "./answer";
import type { ReadPage } from "./page-text";

// The research plug's done condition in code: the first failed rule wins, and its part is named in plain words.
const rules = {
  emptyText: "an empty spoken line or card text",
  claimWithoutSource: "claims without a source",
  noCitation: "a card with no citations",
  unreadCitation: "citations to pages that were not read",
  badLink: "links to pages that were not read",
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

// Marker [s1]; inline link [text](url) or ![text](url); a reference definition [x]: url at line start; an autolink <scheme:...>.
const markerPattern = /\[(s\d+)\](?!\()/g;
const inlineLinkPattern =
  /!?\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const definitionPattern = /^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm;
const autolinkPattern = /<([a-z][a-z0-9+.-]{1,31}:[^<>\s]*)>/gi;

type Card = {
  markerIds: string[];
  linkUrls: string[];
  definitions: number;
  autolinks: number;
};

// Definitions are matched first so a definition's label is never taken for a marker.
function scanCard(cardText: string): Card {
  const definitions = cardText.match(definitionPattern) ?? [];
  const body = cardText.replace(definitionPattern, "");
  return {
    markerIds: [...body.matchAll(markerPattern)].map((match) => match[1]),
    linkUrls: [...body.matchAll(inlineLinkPattern)].map((match) => match[2]),
    definitions: definitions.length,
    autolinks: (body.match(autolinkPattern) ?? []).length,
  };
}

// Invalid link destinations go and their visible text stays; valid markers become links once; unknown ids stay plain text.
function rewriteCard(cardText: string, pages: ReadPage[]): string {
  const byId = new Map(pages.map((page) => [page.id, page.url]));
  const readUrls = new Set(pages.map((page) => page.url));
  return cardText
    .replace(definitionPattern, "")
    .replace(autolinkPattern, (_whole, url: string) => url)
    .replace(inlineLinkPattern, (whole, label: string, url: string) =>
      readUrls.has(url) ? whole : label,
    )
    .replace(markerPattern, (whole, id: string) => {
      const url = byId.get(id);
      return url === undefined ? whole : `[${id}](${url})`;
    })
    .trim();
}

function citedPages(answer: Answer, card: Card, pages: ReadPage[]): ReadPage[] {
  const ids = new Set([
    ...answer.claims.flatMap((claim) => claim.sourceIds),
    ...card.markerIds,
  ]);
  const urls = new Set(card.linkUrls);
  return pages.filter((page) => ids.has(page.id) || urls.has(page.url));
}

function failedRule(
  answer: Answer,
  card: Card,
  pages: ReadPage[],
): CheckRule | null {
  if (answer.spokenLine.trim() === "" || answer.cardText.trim() === "") {
    return "emptyText";
  }
  const { claims } = answer;
  if (claims.length === 0 || claims.some((c) => c.sourceIds.length === 0)) {
    return "claimWithoutSource";
  }
  if (card.markerIds.length === 0) return "noCitation";
  const readIds = new Set(pages.map((page) => page.id));
  const ids = [...claims.flatMap((c) => c.sourceIds), ...card.markerIds];
  if (!ids.every((id) => readIds.has(id))) return "unreadCitation";
  const readUrls = new Set(pages.map((page) => page.url));
  const linksRead = card.linkUrls.every((url) => readUrls.has(url));
  if (!linksRead || card.definitions > 0 || card.autolinks > 0) {
    return "badLink";
  }
  return null;
}

export function checkAnswer(answer: Answer, pages: ReadPage[]): CodeCheck {
  const card = scanCard(answer.cardText);
  const cited = citedPages(answer, card, pages);
  const findings: Findings = {
    cardText: rewriteCard(answer.cardText, pages),
    sources: cited.map(({ id, url, title }) => ({ id, url, title })),
    openPoints: answer.openPoints,
  };
  const rule = failedRule(answer, card, pages);
  return rule === null
    ? { passed: true, findings, cited }
    : { passed: false, rule, uncheckedPart: rules[rule], findings };
}
