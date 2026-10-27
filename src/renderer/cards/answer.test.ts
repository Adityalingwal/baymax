import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Answer } from "./Answer";

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Answer, {
      taskId: "t1",
      markdown,
      openSource: () => undefined,
    }),
  );
}

const cases: [string, string, (html: string) => void][] = [
  [
    "raw HTML is skipped",
    "Some <b>bold</b> words.",
    (html) => {
      expect(html).not.toContain("<b>");
      expect(html).not.toContain("&lt;b&gt;");
    },
  ],
  [
    "images are removed",
    "Look ![a cat](https://cats.example/cat.png) here.",
    (html) => expect(html).not.toContain("<img"),
  ],
  [
    "a normal link becomes a button with its text and no href",
    "See [the docs](https://docs.example/page).",
    (html) => {
      expect(html).toMatch(/<button type="button"[^>]*>the docs<\/button>/);
      expect(html).not.toContain("href=");
    },
  ],
  [
    "a javascript: link renders as text with no button",
    "Click [here](javascript:alert(1)) now.",
    (html) => {
      expect(html).toContain("here");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("href=");
    },
  ],
];

describe("Answer renders Markdown safely", () => {
  it.each(cases)("%s", (_name, markdown, check) => {
    check(render(markdown));
  });
});
