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
