import type { Findings } from "../../../shared/cards";
import type { ReadPage } from "./page-text";
import { hostOf } from "./url-rules";
import type { AnswerFault } from "./worker-prompt";

// The worker's one output: the report for the screen, the line said and shown, the read pages behind them, or why nothing helped.
export type Answer = {
  report: string;
  line: string;
  sourceIds: string[];
  nothingFound: string | null;
};

const text = { type: "string" };

export const answerSchema = {
  type: "object",
  properties: {
    report: text,
    line: text,
    sourceIds: { type: "array", items: text },
    nothingFound: { anyOf: [{ type: "null" }, text] },
  },
  required: ["report", "line", "sourceIds", "nothingFound"],
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
  const { report, line, nothingFound } = fields;
  const sourceIds = stringList(fields.sourceIds);
  if (typeof report !== "string" || typeof line !== "string") return null;
  if (sourceIds === null) return null;
  if (nothingFound !== null && typeof nothingFound !== "string") return null;
  return { report, line, sourceIds, nothingFound };
}

// A leftover source marker such as [s1] or [s1, s2], with the spaces before it, is removed; the card names no sources.
const marker = String.raw`[ \t]*\[\s*s\d+(?:\s*,\s*s\d+)*\s*\]`;

const markerToken = new RegExp(String.raw`\\[\s\S]|${marker}`, "gi");

// Every bracket or autolink start is escaped, so no link, image or reference can form; an escape pair stays as written.
const escapeToken = /\\[\s\S]|[[\]]|<[a-zA-Z][a-zA-Z0-9+.-]*:/g;

// Two passes, so removing a marker can never join text into a link: markers go first, then the escape pass runs on what is left.
function rewriteCard(report: string): string {
  const unmarked = report.replace(markerToken, (token) =>
    token.startsWith("\\") ? token : "",
  );
  return unmarked
    .replace(escapeToken, (token) =>
      token.startsWith("\\") ? token : `\\${token}`,
    )
    .trim();
}

type AnswerCheck =
  | { kind: "valid"; spokenLine: string; findings: Findings }
  | { kind: "nothingFound"; reason: string }
  | { kind: "invalid"; fault: AnswerFault };

// The research plug's done condition in code: ids that were not read are dropped, and an empty report is valid.
export function checkAnswer(answer: Answer, pages: ReadPage[]): AnswerCheck {
  const spokenLine = answer.line.trim();
  const reason = answer.nothingFound?.trim() ?? "";
  if (reason !== "" && spokenLine === "" && answer.report.trim() === "") {
    return { kind: "nothingFound", reason };
  }
  if (answer.nothingFound !== null) {
    return { kind: "invalid", fault: "nothingFoundBeside" };
  }
  if (spokenLine === "") return { kind: "invalid", fault: "noLine" };
  const ids = new Set(answer.sourceIds);
  const read = pages.filter((page) => ids.has(page.id));
  if (read.length === 0) return { kind: "invalid", fault: "noSources" };
  const findings = {
    cardText: rewriteCard(answer.report),
    sources: read.map(({ id, url, title }) => ({ id, url, title })),
    openPoints: [],
  };
  return { kind: "valid", spokenLine, findings };
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

// What a run that ended short found: its kept answer, else the pages it read, else nothing.
export function foundFindings(
  kept: Findings | null,
  pages: ReadPage[],
): Findings | null {
  if (kept !== null) return kept;
  return pages.length === 0 ? null : pageList(pages);
}
