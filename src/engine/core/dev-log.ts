// Ids, roles, models, counts, dollars, times, failure causes, search words and hostnames only: never a path, a query string of a URL, a key, a header or a prompt.
export type DevLogEntry = { event: string } & Record<
  string,
  string | number | boolean | null
>;

export type DevLog = (entry: DevLogEntry) => void;

export const writeDevLog: DevLog = (entry) => {
  console.info("[engine]", JSON.stringify(entry));
};

// What one task's entries add up to, for its one end line.
export function createTaskTally(log: DevLog) {
  const pagesRead = new Set<unknown>();
  const totals = { pagesFailed: 0, searches: 0, outputTokens: 0 };
  const count = ({ event, tool, outcome, ...entry }: DevLogEntry) => {
    if (event === "modelCall") {
      totals.outputTokens += Number(entry.outputTokens ?? 0);
    }
    if (event !== "toolCall" || outcome === "aborted") return;
    if (tool === "search" && outcome !== "limitHit") totals.searches += 1;
    if (tool !== "read") return;
    if (outcome === "ok") pagesRead.add(entry.sourceId);
    else totals.pagesFailed += 1;
  };
  return {
    log: (entry: DevLogEntry) => {
      count(entry);
      log(entry);
    },
    totals: () => ({ ...totals, pagesRead: pagesRead.size }),
  };
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A failing log never stops a command from settling or a cancel from being answered.
export function guardLog(log: DevLog): DevLog {
  return (entry) => {
    try {
      log(entry);
    } catch {
      // the dev log is best effort
    }
  };
}
