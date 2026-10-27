import { describe, expect, it } from "vitest";
import { ipcChannels } from "../shared/ipc";
import { findings } from "./tasks/harness";
import { admitAs, admitTask, runToDone, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const tenMinutes = 10 * 60 * 1000;

const endedRows = [
  { name: "done", end: runToDone },
  {
    name: "incomplete",
    end: (w: Wired) => {
      admitTask(w);
      w.port.emit({
        type: "incomplete",
        taskId: "t1",
        incomplete: { kind: "limitHit", findings: findings("Part.") },
      });
    },
  },
];

const fold = (w: Wired, folded: boolean) =>
  w.send(ipcChannels.setCardFolded, { taskId: "t1", folded });

describe("an ended card stays until the user acts", () => {
  it.each(endedRows)(
    "keeps a $name card open after 10 minutes",
    ({ name, end }) => {
      const w = wire();
      end(w);
      w.advance(tenMinutes);
      expect(w.card("t1")).toMatchObject({ state: name, folded: false });
    },
  );

  it.each(endedRows)(
    "folds, unfolds and closes a $name card",
    ({ name, end }) => {
      const w = wire();
      end(w);
      fold(w, true);
      expect(w.card("t1")).toMatchObject({ state: name, folded: true });
      fold(w, false);
      expect(w.card("t1")).toMatchObject({ state: name, folded: false });
      w.send(ipcChannels.closeCard, { taskId: "t1" });
      expect(w.card("t1")).toBeUndefined();
      expect(w.failures).toEqual([]);
    },
  );
});

// t2 waits behind t1, so cancelling it ends it at once.
function cancelledQueued(): Wired {
  const w = wire();
  admitAs(w, "t1", "hermes");
  admitAs(w, "t2", "rust");
  w.send(ipcChannels.cancelTask, { taskId: "t2" });
  return w;
}

describe("a cancelled card's actions", () => {
  it("drops folding a cancelled card", () => {
    const w = cancelledQueued();
    const published = w.published.length;
    w.send(ipcChannels.setCardFolded, { taskId: "t2", folded: true });
    expect(w.published).toHaveLength(published);
    expect(w.card("t2")).toMatchObject({ state: "cancelled", folded: false });
  });

  it("closes a cancelled card before its 3 s, and the later timer changes nothing", () => {
    const w = cancelledQueued();
    w.advance(1000);
    w.send(ipcChannels.closeCard, { taskId: "t2" });
    expect(w.card("t2")).toBeUndefined();
    const published = w.published.length;
    w.advance(2000);
    expect(w.published).toHaveLength(published);
    expect(w.failures).toEqual([]);
  });
});
