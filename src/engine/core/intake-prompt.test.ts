import { describe, expect, it } from "vitest";
import type { RecentExchange } from "../../shared/engine";
import { buildUserMessage, intakeInstructions } from "./intake-prompt";
import type { IntakeCommand } from "./intake-prompt";

const exchange = (cardText: string | null): RecentExchange => ({
  taskId: "task-1",
  state: "done",
  question: "best headphones",
  answer: "Sony wins.",
  cardText,
});

const asked = (recent: RecentExchange[]): IntakeCommand => ({
  type: "question",
  taskId: "task-2",
  utteranceId: null,
  words: "which is cheapest?",
  recent,
  waiting: null,
});

const line =
  "- task task-1 (done): question: best headphones | answer: Sony wins.";

const rows: [string, RecentExchange[], string][] = [
  [
    "shows the card under its line",
    [exchange("## Top\n1. Sony [s1]")],
    `<recent>\n${line}\n  card: ## Top\n1. Sony [s1]\n</recent>`,
  ],
  [
    "shows no card line without card text",
    [exchange(null)],
    `<recent>\n${line}\n</recent>`,
  ],
];

describe("buildUserMessage recent block", () => {
  it.each(rows)("%s", (_name, recent, block) => {
    expect(buildUserMessage(asked(recent))).toContain(block);
  });
});

describe("intakeInstructions", () => {
  it("tells the intake that pointing into a card makes a followUp", () => {
    expect(intakeInstructions).toContain(
      'An exchange may show its card, the content of that earlier answer. Words that point into a card, such as "these", "the second one" or "that number", make a followUp of that task, not a reason to clarify.',
    );
  });
});
