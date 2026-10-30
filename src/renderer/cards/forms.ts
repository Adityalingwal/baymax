import type { Source, TaskCard, TaskState } from "../../shared/cards";

// One line naming the task: the front call's title, or the raw words until there is one.
export function cardTitle(card: Pick<TaskCard, "title" | "words">): string {
  return card.title ?? card.words;
}

// The report to show; null when there is none, so an empty report never shows a blank answer.
export function shownReport(card: Pick<TaskCard, "answer">): string | null {
  const report = card.answer?.cardText ?? "";
  return report === "" ? null : report;
}

// Only the Running layout has a label: a finished or failed card shows none.
const stateLabels: Partial<Record<TaskState, string>> = {
  queued: "Queued",
  running: "Running",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
};

export type CardContents = {
  label: string | null;
  pulse: boolean; // the label's pulsing dot
  live: string | null; // the progress line that shimmers
  line: string | null; // a finished card's summary or a failed card's cause
  stop: boolean;
  retry: boolean;
  report: string | null; // behind the card's button, on the report page
  sources: Source[]; // the row on the card itself; a report keeps its sources on its page
};

// What each kind of card shows. Rules: design-lock-panel-contents.md, "Tasks tab" and "Report card".
export function cardContents(card: TaskCard): CardContents {
  const { state, answer } = card;
  const report = state === "done" ? shownReport(card) : null;
  const finished = state === "done" || state === "failed";
  return {
    label: stateLabels[state] ?? null,
    pulse: state === "running",
    live: state === "running" ? card.step : null,
    line:
      state === "done"
        ? card.spokenLine
        : state === "failed"
          ? card.line
          : null,
    stop: state === "queued" || state === "running",
    retry: state === "failed" && card.canRetry,
    report,
    sources: finished && report === null ? (answer?.sources ?? []) : [],
  };
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
