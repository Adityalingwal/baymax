import { describe, expect, it } from "vitest";
import {
  EARLY_FAILURE_MS,
  RELAUNCH_MARKER,
  RESTART_DELAY_MS,
  createRestart,
} from "./restart";
import { createClock } from "./tasks/harness";

type Setup = {
  args?: string[];
  failAfterMs?: number; // time since start when the failure happens
  throwing?: ("notice" | "stopWork" | "relaunch")[];
};

function setup({ args = ["."], failAfterMs = 0, throwing = [] }: Setup) {
  const clock = createClock();
  const timeline: string[] = [];
  const throwIf = (what: "notice" | "stopWork" | "relaunch"): void => {
    if (throwing.includes(what)) throw new Error(`${what} broke`);
  };
  const startedAt = 5000;
  const fail = createRestart({
    showNotice: () => {
      timeline.push("notice");
      throwIf("notice");
    },
    stopWork: () => {
      timeline.push("stopWork");
      throwIf("stopWork");
    },
    relaunch: (relaunchArgs) => {
      timeline.push(`relaunch ${relaunchArgs.join(" ")}`);
      throwIf("relaunch");
    },
    exit: (code) => timeline.push(`exit ${code}`),
    setTimer: clock.setTimer,
    log: () => undefined,
    now: () => startedAt + failAfterMs,
    startedAt,
    args,
  });
  return { fail, timeline, advance: clock.advance };
}

const relaunch = `relaunch . ${RELAUNCH_MARKER}`;

type Row = Setup & { name: string; expected: string[] };

const rows: Row[] = [
  {
    name: "a throwing notice still stops work, relaunches and exits",
    throwing: ["notice"],
    expected: ["notice", "stopWork", relaunch, "exit 0"],
  },
  {
    name: "a throwing stopWork still relaunches and exits",
    throwing: ["stopWork"],
    expected: ["notice", "stopWork", relaunch, "exit 0"],
  },
  {
    name: "a throwing relaunch still exits",
    throwing: ["relaunch"],
    expected: ["notice", "stopWork", relaunch, "exit 0"],
  },
  {
    name: "a marker already in the arguments is carried once",
    args: [".", RELAUNCH_MARKER, "--inspect"],
    failAfterMs: EARLY_FAILURE_MS + 60_000,
    expected: [
      "notice",
      "stopWork",
      `relaunch . --inspect ${RELAUNCH_MARKER}`,
      "exit 0",
    ],
  },
  {
    name: "a relaunched app failing at 10 000 ms restarts normally",
    args: [".", RELAUNCH_MARKER],
    failAfterMs: EARLY_FAILURE_MS,
    expected: ["notice", "stopWork", relaunch, "exit 0"],
  },
];

describe("createRestart", () => {
  it("shows the notice, stops work, then relaunches with the marker and exits after the delay", () => {
    const { fail, timeline, advance } = setup({});
    fail(new Error("boom"), "uncaughtException");
    expect(timeline).toEqual(["notice", "stopWork"]);
    advance(RESTART_DELAY_MS - 1);
    expect(timeline).toEqual(["notice", "stopWork"]);
    advance(1);
    expect(timeline).toEqual(["notice", "stopWork", relaunch, "exit 0"]);
  });

  it("ignores a second failure while a restart is pending", () => {
    const { fail, timeline, advance } = setup({});
    fail(new Error("first"), "uncaughtException");
    fail(new Error("second"), "unhandledRejection");
    advance(RESTART_DELAY_MS * 2);
    expect(timeline).toEqual(["notice", "stopWork", relaunch, "exit 0"]);
  });

  it.each(rows)("$name", (row) => {
    const { fail, timeline, advance } = setup(row);
    expect(() => fail(new Error("boom"), "uncaughtException")).not.toThrow();
    expect(() => advance(RESTART_DELAY_MS)).not.toThrow();
    expect(timeline).toEqual(row.expected);
  });

  it("stops the loop when a relaunched app fails within 10 s of start", () => {
    const { fail, timeline, advance } = setup({
      args: [".", RELAUNCH_MARKER],
      failAfterMs: EARLY_FAILURE_MS - 1,
    });
    fail(new Error("boom"), "uncaughtException");
    expect(timeline).toEqual(["exit 1"]);
    advance(RESTART_DELAY_MS);
    expect(timeline).toEqual(["exit 1"]);
  });
});
