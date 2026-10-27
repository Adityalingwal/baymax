// Ids, roles, models, counts, dollars, times and failure causes only: never a key, a header, a prompt or the user's words.
export type DevLogEntry = { event: string } & Record<
  string,
  string | number | boolean | null
>;

export type DevLog = (entry: DevLogEntry) => void;

export const writeDevLog: DevLog = (entry) => {
  console.info("[engine]", JSON.stringify(entry));
};
