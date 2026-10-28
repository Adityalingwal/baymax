import { describe, expect, it } from "vitest";
import {
  thinkingFields,
  workerInstructions,
  workerThinking,
} from "./worker-prompt";
import type { ThinkingMode } from "./worker-prompt";

const jsonOnlyLine =
  "The JSON output format applies to your final answer only. When you need a tool, call it first, with no text before the call, and write the JSON once you have the results.";

type Row = {
  mode: ThinkingMode;
  thinking: string;
  effort: string;
  jsonLine: boolean;
};

const rows: Row[] = [
  { mode: "off", thinking: "between_tools", effort: "medium", jsonLine: true },
  { mode: "low", thinking: "adaptive", effort: "low", jsonLine: false },
];

describe("worker thinking switch", () => {
  it.each(rows)("maps $mode to its request fields", (row) => {
    expect(thinkingFields(row.mode)).toEqual({
      thinking: { type: row.thinking },
      effort: row.effort,
    });
    expect(workerInstructions(row.mode).includes(jsonOnlyLine)).toBe(
      row.jsonLine,
    );
  });

  it("is off by default", () => {
    expect(workerThinking).toBe("off");
  });
});

describe("worker depth rule", () => {
  it("asks for at least five sources unless the question is one simple fact", () => {
    const text = workerInstructions(workerThinking);
    expect(text).toContain(
      "a question that is a single simple fact (a date, a number, a definition) may stop after one or two good sources. Any other question needs at least 5 different sources read, each from a different site, before you write the answer, and more when they disagree or leave part of the brief open. A failed read does not count as a source.",
    );
    expect(text).not.toContain("Stop when the brief is answered.");
    expect(text).toContain(
      "You may call several tools at once when they do not depend on each other. When a read fails, try another source.",
    );
  });
});
