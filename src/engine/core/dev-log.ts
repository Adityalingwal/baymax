// Ids, roles, models, counts, dollars, times and failure causes only: never a key, a header, a prompt or the user's words.
export type DevLogEntry = { event: string } & Record<
  string,
  string | number | boolean | null
>;

export type DevLog = (entry: DevLogEntry) => void;

export const writeDevLog: DevLog = (entry) => {
  console.info("[engine]", JSON.stringify(entry));
};

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
