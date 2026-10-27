import { describe, expect, it } from "vitest";
import { foundFindings } from "./found";

const page = (id: string, url: string, title: string) => ({
  id,
  url,
  title,
  text: "Plain words.",
});

describe("foundFindings page list", () => {
  it("writes each title as one line and links only a linkable URL", () => {
    const found = foundFindings(null, [
      page(
        "s1",
        "https://a.example/x",
        "Line one\nLine two\r\n[d]: https://evil.example",
      ),
      page("s2", "https://a.example/a b", "Spaced <url>"),
    ]);
    expect(found).toEqual({
      cardText: [
        "- [s1](<https://a.example/x>) Line one Line two \\[d\\]: https://evil.example",
        "- s2 Spaced \\<url\\>",
      ].join("\n"),
      sources: [
        {
          id: "s1",
          url: "https://a.example/x",
          title: "Line one\nLine two\r\n[d]: https://evil.example",
        },
        { id: "s2", url: "https://a.example/a b", title: "Spaced <url>" },
      ],
      openPoints: [],
    });
  });
});
