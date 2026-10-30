import type { Findings } from "../../../shared/cards";
import type { ReadPage } from "./page-text";
import { hostOf } from "./url-rules";

// The worker's one output: the spoken line, the card text and the claims that tie it to read pages.
type Claim = { claim: string; sourceIds: string[] };

const statuses = ["complete", "sourcesThin", "needsUser"] as const;
type AnswerStatus = (typeof statuses)[number];

export type Answer = {
  spokenLine: string;
  cardText: string;
  claims: Claim[];
  openPoints: string[];
  status: AnswerStatus;
  nextQuestion: string | null; // set exactly when status is needsUser
};

const text = { type: "string" };
const textList = { type: "array", items: text };

export const answerSchema = {
  type: "object",
  properties: {
    spokenLine: text,
    cardText: text,
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: text, sourceIds: textList },
        required: ["claim", "sourceIds"],
        additionalProperties: false,
      },
    },
    openPoints: textList,
    status: { type: "string", enum: [...statuses] },
    nextQuestion: { anyOf: [{ type: "null" }, text] },
  },
  required: [
    "spokenLine",
    "cardText",
    "claims",
    "openPoints",
    "status",
    "nextQuestion",
  ],
  additionalProperties: false,
};

type Fields = Record<string, unknown>;

function fieldsWith(value: unknown, keys: string[]): Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const own = Object.keys(value);
  const exact =
    own.length === keys.length && keys.every((key) => own.includes(key));
  return exact ? (value as Fields) : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? value : null;
}

function claimFrom(value: unknown): Claim | null {
  const fields = fieldsWith(value, ["claim", "sourceIds"]);
  if (fields === null || typeof fields.claim !== "string") return null;
  const sourceIds = stringList(fields.sourceIds);
  return sourceIds === null ? null : { claim: fields.claim, sourceIds };
}

function claimsFrom(value: unknown): Claim[] | null {
  if (!Array.isArray(value)) return null;
  const claims = value.map(claimFrom);
  return claims.every((claim) => claim !== null) ? claims : null;
}

// A next question goes with needsUser and nothing else; any other pairing is malformed.
function statusFrom(
  fields: Fields,
): Pick<Answer, "status" | "nextQuestion"> | null {
  const { status, nextQuestion } = fields;
  const known = statuses.find((value) => value === status);
  if (known === undefined) return null;
  if (known !== "needsUser") {
    return nextQuestion === null ? { status: known, nextQuestion } : null;
  }
  if (typeof nextQuestion !== "string" || nextQuestion.trim() === "") {
    return null;
  }
  return { status: known, nextQuestion: nextQuestion.trim() };
}

// Anything off the schema is malformed; empty strings pass here and meet the code check.
export function parseAnswer(json: string): Answer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const fields = fieldsWith(parsed, answerSchema.required);
  if (fields === null) return null;
  const { spokenLine, cardText } = fields;
  const claims = claimsFrom(fields.claims);
  const openPoints = stringList(fields.openPoints);
  const status = statusFrom(fields);
  if (typeof spokenLine !== "string" || typeof cardText !== "string") {
    return null;
  }
  if (claims === null || openPoints === null || status === null) return null;
  return { spokenLine, cardText, claims, openPoints, ...status };
}

// The research plug's done condition in code: the first failed rule wins, and its part is named in plain words.
const rules = {
  emptyText: "an empty spoken line or card text",
  claimWithoutSource: "claims without a source",
  unreadCitation: "citations to pages that were not read",
} as const;

type CheckRule = keyof typeof rules;

type CodeCheck =
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
