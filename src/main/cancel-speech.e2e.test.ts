import { describe, expect, it } from "vitest";
import type { TaskId } from "../shared/cards";
import { ipcChannels } from "../shared/ipc";
import { fixedLines } from "./tasks/lines";
import { admitAs, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const startLine = "Looking into hermes.";

type SpeechRow = {
  name: string;
  taskId: TaskId; // t1 runs and says its start line first; t2 waits and says the queued line
  before: (w: Wired) => Promise<void>;
  spoken: string[];
  stopped: boolean;
};

const rows: SpeechRow[] = [
  {
    name: "waiting behind another line",
    taskId: "t2",
    before: () => Promise.resolve(),
    spoken: [startLine],
    stopped: false,
  },
  {
    name: "being synthesized",
    taskId: "t1",
    before: () => Promise.resolve(),
    spoken: [fixedLines.queued],
    stopped: false,
  },
  {
    name: "playing",
    taskId: "t1",
    before: async (w) => {
      await w.settleNext();
    },
    spoken: [startLine, fixedLines.queued],
    stopped: true,
  },
];

function twoAsked(): Wired {
  const w = wire();
  admitAs(w, "t1", "hermes");
  admitAs(w, "t2", "rust");
  return w;
}

describe("cancel stops that task's speech", () => {
  it.each(rows)("drops its line $name", async (row) => {
    const w = twoAsked();
    await row.before(w);
    const playing = w.speeches.at(0)?.lineId;
    w.send(ipcChannels.cancelTask, { taskId: row.taskId });
    expect(w.stops).toEqual(row.stopped ? [{ lineId: playing }] : []);
    await w.playAll();
    expect(w.spoken()).toEqual(row.spoken);
    expect(w.failures).toEqual([]);
  });
});
