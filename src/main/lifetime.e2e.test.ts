import { describe, expect, it } from "vitest";
import { findings } from "./tasks/harness";
import { admitTask, runToDone, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const tenMinutes = 10 * 60 * 1000;

const endedRows = [
  { name: "done", end: runToDone },
  {
    name: "incomplete",
    end: async (w: Wired) => {
      await admitTask(w);
      w.port.emit({
        type: "incomplete",
        taskId: "t1",
        incomplete: { kind: "limitHit", findings: findings("Part.") },
      });
    },
  },
];

describe("an ended card stays until the user acts", () => {
  it.each(endedRows)(
    "keeps a $name card open after 10 minutes",
    async ({ name, end }) => {
      const w = wire();
      await end(w);
      w.advance(tenMinutes);
      expect(w.card("t1")).toMatchObject({ state: name });
    },
  );
});
