import type { Findings, TaskId } from "../../../src/shared/cards";

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
  const date = () => new Date(Date.UTC(2026, 9, 31, 12) + now);
  return { setTimer, advance, date, pending: () => pending.length };
}

export function findings(text: string, urls: string[] = []): Findings {
  return {
    cardText: text,
    sources: urls.map((url, index) => ({
      id: `s${index + 1}`,
      url,
      title: url,
    })),
  };
}

// The decide tool's input: every field present, unused ones empty.
export function decision(fields: Record<string, unknown>) {
  return {
    route: "reply",
    topic: null,
    goal: null,
    taskId: null,
    answerTo: null,
    ...fields,
  };
}

export const replyRoute = (answerTo: string | null = null) =>
  decision({ route: "reply", answerTo });

export const workRoute = (topic: string, answerTo: string | null = null) =>
  decision({ route: "work", topic, goal: topic, answerTo });

export const workOnRoute = (taskId: TaskId, topic: string) =>
  decision({ route: "work", topic, goal: topic, taskId });

export const askRoute = (topic: string | null = "about it") =>
  decision({ route: "ask", topic });

export const stopRoute = (taskId: TaskId) =>
  decision({ route: "stop", taskId });
