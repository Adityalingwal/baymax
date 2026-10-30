import { describe, expect, it } from "vitest";
import type { TaskCard, TaskState } from "../../../src/shared/cards";
import type { SpokenKind, VoicePhase } from "../../../src/shared/ipc";
import {
  closedView,
  isAnswerLine,
  islandWidth,
  runningCount,
} from "../../../src/renderer/notch/views";
import type { ClosedView } from "../../../src/renderer/notch/views";

describe("closedView", () => {
  it.each<{
    island: boolean;
    pill: boolean;
    running: number;
    view: ClosedView;
  }>([
    { island: false, pill: false, running: 0, view: "notch" },
    { island: false, pill: false, running: 1, view: "ring" },
    { island: false, pill: true, running: 0, view: "pill" },
    { island: false, pill: true, running: 2, view: "pill" },
    { island: true, pill: true, running: 0, view: "island" },
    { island: true, pill: true, running: 3, view: "island" },
  ])(
    "island $island, pill $pill, $running running: $view",
    ({ island, pill, running, view }) => {
      expect(closedView({ island, pill, running })).toBe(view);
    },
  );
});

describe("runningCount", () => {
  it("counts running and queued tasks only", () => {
    const states: TaskState[] = [
      "running",
      "queued",
      "thinking",
      "clarifying",
      "cancelling",
      "done",
    ];
    expect(runningCount(states.map((state) => ({ state })))).toBe(2);
  });
});

describe("islandWidth", () => {
  it.each([
    { lines: 1, width: 480 },
    { lines: 3, width: 480 },
    { lines: 4, width: 628 },
    { lines: 6, width: 628 },
  ])("$lines lines at 480 pt: $width", ({ lines, width }) => {
    expect(islandWidth(lines, 628)).toBe(width);
  });
});

type Card = Pick<TaskCard, "taskId" | "state" | "reply" | "answer">;

const done: Card = {
  taskId: "t1",
  state: "done",
  reply: "I'll check.",
  answer: {
    cardText: "Hermes runs a loop.",
    sources: [{ id: "s", url: "https://a.com", title: "A" }],
  },
};
const chat: Card = {
  taskId: "t1",
  state: "done",
  reply: "Hi there.",
  answer: { cardText: "Hi there.", sources: [] },
};

const speaking = (kind: SpokenKind, taskId: string | null): VoicePhase => ({
  phase: "speaking",
  line: { lineId: "l1", taskId, kind },
});

type AnswerRow = {
  name: string;
  phase: VoicePhase;
  tasks: Card[];
  answer: boolean;
};

const answerRows: AnswerRow[] = [
  {
    name: "a done task's answer",
    phase: speaking("answer", "t1"),
    tasks: [done],
    answer: true,
  },
  {
    name: "a failed task's line",
    phase: speaking("failure", "t1"),
    tasks: [{ ...done, state: "failed" }],
    answer: false,
  },
  {
    name: "a failure line",
    phase: speaking("failure", "t1"),
    tasks: [done],
    answer: false,
  },
  {
    name: "a question",
    phase: speaking("question", "t1"),
    tasks: [done],
    answer: false,
  },
  {
    name: "a notice",
    phase: speaking("notice", null),
    tasks: [done],
    answer: false,
  },
  {
    name: "the front call's line",
    phase: speaking("talk", "t1"),
    tasks: [done],
    answer: false,
  },
  {
    name: "a chat reply",
    phase: speaking("answer", "t1"),
    tasks: [chat],
    answer: false,
  },
  {
    name: "a task no longer shown",
    phase: speaking("answer", "t1"),
    tasks: [],
    answer: false,
  },
  {
    name: "not speaking",
    phase: { phase: "thinking" },
    tasks: [done],
    answer: false,
  },
];

describe("isAnswerLine", () => {
  it.each(answerRows)("$name: $answer", ({ phase, tasks, answer }) => {
    expect(isAnswerLine(phase, tasks)).toBe(answer);
  });
});
