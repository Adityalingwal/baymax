import type { Findings, TaskId } from "../../shared/cards";

type PendingTimer = { at: number; order: number; fire: () => void };

// A manual clock: advancing fires every due timer in time order, then stops at the target.
export function createClock() {
  let now = 0;
  let order = 0;
  let pending: PendingTimer[] = [];
  const setTimer = (ms: number, fire: () => void): (() => void) => {
    order += 1;
    const timer = { at: now + ms, order, fire };
    pending.push(timer);
    return () => {
      pending = pending.filter((other) => other !== timer);
    };
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = pending
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order);
      if (due.length === 0) break;
      pending = pending.filter((timer) => timer !== due[0]);
      now = due[0].at;
      due[0].fire();
    }
    now = target;
  };
  return { setTimer, advance, pending: () => pending.length };
}

export function findings(text: string, urls: string[] = []): Findings {
  return {
    cardText: text,
    sources: urls.map((url, index) => ({
      id: `s${index + 1}`,
      url,
      title: url,
    })),
    openPoints: [],
  };
}

// The decide tool's input: every field present, unused ones empty.
export function decision(fields: Record<string, unknown>) {
  return {
    route: "chat",
    topic: null,
    parentTaskId: null,
    answerTo: null,
    choices: [],
    goal: null,
    ...fields,
  };
}

export const chat = () => decision({ route: "chat" });

export const outsideResearch = () => decision({ route: "outsideResearch" });

export const newTask = (topic: string, answerTo: string | null = null) =>
  decision({ route: "newTask", topic, goal: topic, answerTo });

export const followUp = (parentTaskId: TaskId, topic: string) =>
  decision({
    route: "followUp",
    topic,
    parentTaskId,
    goal: topic,
  });

export const clarify = (choices = ["First", "Second", "Third"]) =>
  decision({ route: "clarify", topic: "about it", choices });
