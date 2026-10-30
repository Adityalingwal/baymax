import type { Source, TaskCard, TaskState } from "../../shared/cards";

export type CardForm = "pill" | "question" | "open";

// Results stay open in the panel; folding into the notch is gone with the reopen dot.
export function cardForm(card: Pick<TaskCard, "state">): CardForm {
  switch (card.state) {
    case "clarifying":
      return "question";
    case "done":
    case "incomplete":
      return "open";
    default:
      return "pill";
  }
}

// A plain chat reply: main ends a chat as a done card whose answer is the front call's own line, with no sources.
export function isChatReply(
  card: Pick<TaskCard, "state" | "reply" | "answer">,
): boolean {
  const { answer, reply } = card;
  return (
    card.state === "done" &&
    answer !== null &&
    reply !== null &&
    answer.sources.length === 0 &&
    answer.cardText === reply
  );
}

// Work still in flight, so its live line may shimmer; a failed attempt waiting for Retry is not.
export function isPending(card: Pick<TaskCard, "state" | "canRetry">): boolean {
  const { state } = card;
  const working =
    state === "thinking" || state === "queued" || state === "running";
  return working && !card.canRetry;
}

const cancellable: readonly TaskState[] = [
  "thinking",
  "clarifying",
  "queued",
  "running",
];

export function canCancel(state: TaskState): boolean {
  return cancellable.includes(state);
}

const stateLabels: Record<TaskState, string> = {
  thinking: "Thinking",
  clarifying: "Clarifying",
  queued: "Queued",
  running: "Running",
  cancelling: "Cancelling",
  done: "Done",
  incomplete: "Incomplete",
  cancelled: "Cancelled",
};

export function stateLabel(state: TaskState): string {
  return stateLabels[state];
}

export type SourceGroup = {
  label: string;
  sources: Source[];
};

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

export function sourceGroups(sources: Source[]): SourceGroup[] {
  const groups: SourceGroup[] = [];
  const byHost = new Map<string, SourceGroup>();
  for (const source of sources) {
    const host = hostOf(source.url);
    if (host === null) {
      groups.push({ label: source.title, sources: [source] });
      continue;
    }
    const group = byHost.get(host);
    if (group) {
      group.sources.push(source);
      continue;
    }
    const created = { label: host, sources: [source] };
    byHost.set(host, created);
    groups.push(created);
  }
  return groups;
}
