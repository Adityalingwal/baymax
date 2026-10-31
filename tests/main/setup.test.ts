import { describe, expect, it } from "vitest";
import { startSetup } from "../../src/main/setup";
import type { SetupState } from "../../src/shared/ipc";
import { createClock } from "./tasks/harness";

type World = { trusted: boolean; mic: string };
type Change = Partial<World>;

type Row = {
  name: string;
  isMac?: boolean;
  launch: World;
  throwing?: boolean;
  changes?: Change[]; // each applied, then a little over one recheck passes
  state: SetupState;
  starts: number;
  ticking: boolean;
  published?: Partial<SetupState>[];
};

const rows: Row[] = [
  {
    name: "granted at launch: not needed, the hold-key starts once, no recheck",
    launch: { trusted: true, mic: "granted" },
    state: { needed: false, accessibility: "granted", microphone: "granted" },
    starts: 1,
    ticking: false,
    published: [],
  },
  {
    name: "off macOS: not needed, the hold-key starts once at launch",
    isMac: false,
    launch: { trusted: false, mic: "not-determined" },
    state: { needed: false, accessibility: "granted", microphone: "granted" },
    starts: 1,
    ticking: false,
    published: [],
  },
  {
    name: "Accessibility trusted, microphone missing: the hold-key starts at launch and rechecks run",
    launch: { trusted: true, mic: "not-determined" },
    state: { needed: true, accessibility: "granted", microphone: "ask" },
    starts: 1,
    ticking: true,
    published: [],
  },
  {
    name: "still missing: the hold-key waits and nothing is published",
    launch: { trusted: false, mic: "not-determined" },
    changes: [{}, {}],
    state: { needed: true, accessibility: "missing", microphone: "ask" },
    starts: 0,
    ticking: true,
    published: [],
  },
  {
    name: "missing then granted: the hold-key starts once, and the rechecks stop with both granted",
    launch: { trusted: false, mic: "not-determined" },
    changes: [{ trusted: true }, {}, { mic: "granted" }, {}],
    state: { needed: true, accessibility: "granted", microphone: "granted" },
    starts: 1,
    ticking: false,
    published: [{ accessibility: "granted" }, { microphone: "granted" }],
  },
  {
    name: "the microphone granted first: the rechecks go on for Accessibility",
    launch: { trusted: false, mic: "not-determined" },
    changes: [{ mic: "granted" }],
    state: { needed: true, accessibility: "missing", microphone: "granted" },
    starts: 0,
    ticking: true,
  },
  {
    name: "a throwing start after the grant is failed, with no second try",
    launch: { trusted: false, mic: "granted" },
    throwing: true,
    changes: [{ trusted: true }, {}],
    state: { needed: true, accessibility: "failed", microphone: "granted" },
    starts: 1,
    ticking: false,
  },
  {
    name: "a throwing start at launch is failed too, and the app goes on",
    launch: { trusted: true, mic: "not-determined" },
    throwing: true,
    changes: [{}],
    state: { needed: true, accessibility: "failed", microphone: "ask" },
    starts: 1,
    ticking: true,
  },
  {
    name: "a denied microphone stays denied",
    launch: { trusted: true, mic: "denied" },
    state: { needed: true, accessibility: "granted", microphone: "denied" },
    starts: 1,
    ticking: true,
  },
  {
    name: "a restricted microphone counts as denied",
    launch: { trusted: true, mic: "restricted" },
    state: { needed: true, accessibility: "granted", microphone: "denied" },
    starts: 1,
    ticking: true,
  },
  {
    name: "an unknown microphone status can still be asked",
    launch: { trusted: true, mic: "unknown" },
    state: { needed: true, accessibility: "granted", microphone: "ask" },
    starts: 1,
    ticking: true,
  },
];

function launch(row: Row) {
  const clock = createClock();
  const world = { ...row.launch };
  const published: SetupState[] = [];
  let starts = 0;
  const setup = startSetup({
    isMac: row.isMac ?? true,
    isTrusted: () => world.trusted,
    microphoneStatus: () => world.mic,
    startHoldKey: () => {
      starts += 1;
      if (row.throwing === true) throw new Error("hook refused");
    },
    publish: (state) => published.push(state),
    setTimer: clock.setTimer,
    log: () => undefined,
  });
  for (const change of row.changes ?? []) {
    Object.assign(world, change);
    clock.advance(1100);
  }
  return { setup, clock, published, starts: () => starts };
}

describe("first-run setup in main", () => {
  it.each(rows)("$name", (row) => {
    const { setup, clock, published, starts } = launch(row);
    expect(setup.current()).toEqual(row.state);
    expect(starts()).toBe(row.starts);
    expect(clock.pending() > 0).toBe(row.ticking);
    if (row.published !== undefined) {
      expect(published).toHaveLength(row.published.length);
      row.published.forEach((change, index) => {
        expect(published[index]).toMatchObject(change);
      });
    }
  });
});
