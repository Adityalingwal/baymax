import { describe, expect, it } from "vitest";
import type { TaskId } from "../../src/shared/cards";
import { ipcChannels } from "../../src/shared/ipc";
import { frontFailureLine } from "../../src/main/tasks/lines";
import { failFront, wire } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Each task's spoken line here is its fixed failure line.
const firstLine = frontFailureLine("modelsUnreachable", false);
const secondLine = frontFailureLine("keyRejected", false);

type SpeechRow = {
  name: string;
  taskId: TaskId; // t1's line plays first; t2's waits behind it
  before: (w: Wired) => Promise<void>;
  spoken: string[];
  stopped: boolean;
};

const rows: SpeechRow[] = [
  {
    name: "waiting behind another line",
    taskId: "t2",
    before: () => Promise.resolve(),
    spoken: [firstLine],
    stopped: false,
  },
  {
    name: "being synthesized",
    taskId: "t1",
    before: () => Promise.resolve(),
    spoken: [secondLine],
    stopped: false,
  },
  {
    name: "being synthesized after another line played",
    taskId: "t2",
    before: async (w) => {
      await w.playNext();
    },
    spoken: [firstLine],
    stopped: false,
  },
  {
    name: "playing",
    taskId: "t1",
    before: async (w) => {
      await w.settleNext();
    },
    spoken: [firstLine, secondLine],
    stopped: true,
  },
];

async function twoAsked(): Promise<Wired> {
  const w = wire();
  w.send(ipcChannels.submitQuestion, { text: "how does hermes work" });
  w.send(ipcChannels.submitQuestion, { text: "what is new in rust" });
  await flush();
  await failFront(w, "unreachable", 0);
  await failFront(w, "keyRejected", 1);
  return w;
}

describe("cancel stops that task's speech", () => {
  it.each(rows)("drops its line $name", async (row) => {
    const w = await twoAsked();
    await row.before(w);
    const playing = w.speeches.at(0)?.lineId;
    w.send(ipcChannels.cancelTask, { taskId: row.taskId });
    expect(w.stops).toEqual(row.stopped ? [{ lineId: playing }] : []);
    await w.playAll();
    expect(w.spoken()).toEqual(row.spoken);
    expect(w.failures).toEqual([]);
  });
});
