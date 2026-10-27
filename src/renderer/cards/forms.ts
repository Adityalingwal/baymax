import type { Source, TaskCard, TaskState } from "../../shared/cards";

export type CardForm = "pill" | "question" | "open" | "folded";

export function cardForm(card: Pick<TaskCard, "state" | "folded">): CardForm {
  switch (card.state) {
    case "clarifying":
      return "question";
    case "done":
    case "incomplete":
      return card.folded ? "folded" : "open";
    default:
      return "pill";
  }
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
