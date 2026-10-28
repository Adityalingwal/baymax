import { describe, expect, it } from "vitest";
import type { Harness } from "./harness";
import { askNew, createHarness, findings, finish } from "./harness";

const partial = (taskId: string, text: string) =>
  ({
    type: "incomplete",
    taskId,
    incomplete: { kind: "limitHit", findings: findings(text) },
  }) as const;

type CardRow = {
  name: string;
  run: (h: Harness) => void;
  cards: (string | null)[];
};

const cardRows: CardRow[] = [
  {
    name: "only the newest two with findings, a done and an incomplete one",
    run: (h) => {
      finish(h, askNew(h, "a"), "Old.");
      finish(h, askNew(h, "b"), "Mid.");
      h.state.receive(partial(askNew(h, "c"), "Part."));
    },
    cards: [null, "Mid.", "Part."],
  },
  {
    name: "none for a cancelled or a running task",
    run: (h) => {
      finish(h, askNew(h, "a"), "Kept.");
      const cut = askNew(h, "b");
      h.state.cancelTask(cut);
      h.state.receive({ type: "cancelled", taskId: cut, findings: null });
      askNew(h, "c");
    },
    cards: ["Kept.", null, null],
  },
  {
    name: "2000 characters cut to exactly 1500 ending in an ellipsis",
    run: (h) => finish(h, askNew(h, "a"), "x".repeat(2000)),
    cards: [`${"x".repeat(1499)}…`],
  },
  {
    name: "a cut that would split an emoji drops its first half",
    run: (h) =>
      finish(h, askNew(h, "a"), `${"z".repeat(1498)}😀${"z".repeat(9)}`),
    cards: [`${"z".repeat(1498)}…`],
  },
  {
    name: "1500 characters kept whole",
    run: (h) => finish(h, askNew(h, "a"), "y".repeat(1500)),
    cards: ["y".repeat(1500)],
  },
];

describe("recent exchanges with card text", () => {
  it.each(cardRows)("carries $name", (row) => {
    const h = createHarness();
    row.run(h);
    h.state.ask("next", null, null);
    const command = h.sent.at(-1);
    const recent = command?.type === "question" ? command.recent : [];
    expect(recent.map((exchange) => exchange.cardText)).toEqual(row.cards);
    expect(recent.map((exchange) => exchange.taskId)).toEqual(
      row.cards.map((_, i) => `t${i + 1}`),
    );
  });
});
