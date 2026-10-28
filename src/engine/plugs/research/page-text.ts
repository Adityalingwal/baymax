import { convert } from "html-to-text";
import type { HtmlToTextOptions } from "html-to-text";
import type { Source } from "../../../shared/cards";

export type ReadPage = Source & { text: string };
export type PageText = Omit<ReadPage, "id">; // only the web tool gives ids

export type BodyKind = "html" | "plain";
export type TextLimits = { maxChars: number; minChars: number };
export type PageTextResult =
  { ok: true; page: PageText } | { ok: false; cause: "noUsableText" };

const maxTitleChars = 200;

const skipped = ["img", "script", "style", "noscript", "template", "svg"];
const headings = ["h1", "h2", "h3", "h4", "h5", "h6"];

const convertOptions: HtmlToTextOptions = {
  wordwrap: false,
  limits: { maxDepth: 200, maxChildNodes: 2000 },
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    ...skipped.map((selector) => ({ selector, format: "skip" })),
    ...headings.map((selector) => ({
      selector,
      options: { uppercase: false },
    })),
  ],
};

function collapseWhitespace(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFrom(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return "";
  try {
    return collapseWhitespace(convert(match[1], { wordwrap: false })).replace(
      /\s+/g,
      " ",
    );
  } catch {
    return "";
  }
}

function htmlParts(html: string): { title: string; text: string } | null {
  try {
    return { title: titleFrom(html), text: convert(html, convertOptions) };
  } catch {
    return null;
  }
}

// Fewer than minChars visible characters means no usable text, which is how a JavaScript-only page is caught.
// A plain body may bring its title from elsewhere, such as Exa Contents.
export function pageTextFrom(params: {
  body: string;
  kind: BodyKind;
  url: string;
  hostname: string;
  limits: TextLimits;
  title?: string;
}): PageTextResult {
  const { body, kind, url, hostname, limits } = params;
  const parts =
    kind === "html"
      ? htmlParts(body)
      : { title: params.title ?? "", text: body };
  if (parts === null) return { ok: false, cause: "noUsableText" };
  const text = collapseWhitespace(parts.text);
  if (text.replace(/\s/g, "").length < limits.minChars) {
    return { ok: false, cause: "noUsableText" };
  }
  const oneLine = parts.title.replace(/\s+/g, " ");
  const title = oneLine.slice(0, maxTitleChars).trim() || hostname;
  return {
    ok: true,
    page: { url, title, text: text.slice(0, limits.maxChars) },
  };
}
