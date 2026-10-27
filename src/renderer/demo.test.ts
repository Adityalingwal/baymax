import { describe, expect, it } from "vitest";
import type { DisplayState, TaskCard, TaskState } from "../shared/cards";
import { applyDemoAction, demoDisplayState, type DemoAction } from "./demo";

// Frozen, so a reducer that mutates its input throws instead of passing.
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
deepFreeze(demoDisplayState);

function find(state: DisplayState, taskId: string): TaskCard | undefined {
  return state.tasks.find((card) => card.taskId === taskId);
}

const effects: [string, DemoAction, (after: DisplayState) => void][] = [
  [
    "submit adds a thinking card with the words and the next id",
    { kind: "submitQuestion", payload: { text: "What is new?" } },
    (after) => {
      const added = after.tasks[after.tasks.length - 1];
      expect(added.taskId).toBe("demo-11");
      expect(added.state).toBe("thinking");
      expect(added.words).toBe("What is new?");
      expect(after.tasks).toHaveLength(demoDisplayState.tasks.length + 1);
    },
  ],
  [
    "a matching answer marks the question answered",
    {
      kind: "answerQuestion",
      payload: {
        taskId: "demo-8",
        questionId: "q-1",
        reply: { kind: "choice", index: 0 },
      },
    },
    (after) => expect(find(after, "demo-8")?.question?.answered).toBe(true),
  ],
  [
    "cancel moves a cancellable card to cancelling",
    { kind: "cancelTask", payload: { taskId: "demo-9" } },
    (after) => expect(find(after, "demo-9")?.state).toBe("cancelling"),
  ],
  [
    "retry sets canRetry false",
    { kind: "retryTask", payload: { taskId: "demo-10" } },
    (after) => expect(find(after, "demo-10")?.canRetry).toBe(false),
  ],
  [
    "close removes the card",
    { kind: "closeCard", payload: { taskId: "demo-1" } },
    (after) => expect(find(after, "demo-1")).toBeUndefined(),
  ],
  [
    "fold sets folded",
    { kind: "setCardFolded", payload: { taskId: "demo-1", folded: true } },
    (after) => expect(find(after, "demo-1")?.folded).toBe(true),
  ],
  [
    "unfold clears folded",
    { kind: "setCardFolded", payload: { taskId: "demo-2", folded: false } },
    (after) => expect(find(after, "demo-2")?.folded).toBe(false),
  ],
  [
    "mute sets muted",
    { kind: "setMuted", payload: { muted: true } },
    (after) => expect(after.muted).toBe(true),
  ],
];

describe("applyDemoAction changes the demo state", () => {
  it.each(effects)("%s", (_name, action, check) => {
    check(applyDemoAction(demoDisplayState, action));
  });
});

const unchanged: [string, DemoAction][] = [
  [
    "a stale question id",
    {
      kind: "answerQuestion",
      payload: {
        taskId: "demo-8",
        questionId: "q-old",
        reply: { kind: "text", text: "Gaming" },
      },
    },
  ],
  [
    "cancel on an unknown task",
    { kind: "cancelTask", payload: { taskId: "x" } },
  ],
  [
    "cancel on a done card",
    { kind: "cancelTask", payload: { taskId: "demo-1" } },
  ],
  ["retry on an unknown task", { kind: "retryTask", payload: { taskId: "x" } }],
  ["close on an unknown task", { kind: "closeCard", payload: { taskId: "x" } }],
  [
    "fold on an unknown task",
    { kind: "setCardFolded", payload: { taskId: "x", folded: true } },
  ],
  [
    "openSource",
    {
      kind: "openSource",
      payload: { taskId: "demo-1", url: "https://github.com/example/hermes" },
    },
  ],
];

describe("applyDemoAction leaves the demo state unchanged", () => {
  it.each(unchanged)("%s", (_name, action) => {
    expect(applyDemoAction(demoDisplayState, action)).toBe(demoDisplayState);
  });
});

const allStates: TaskState[] = [
  "thinking",
  "clarifying",
  "queued",
  "running",
  "cancelling",
  "done",
  "incomplete",
  "cancelled",
];

it("the demo state has a card in every state", () => {
  const shown = new Set(demoDisplayState.tasks.map((card) => card.state));
  expect([...shown].sort()).toEqual([...allStates].sort());
});
