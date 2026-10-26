import type { EngineStartOptions } from "../shared/engine";

export type SearchKeyName = "EXA_API_KEY" | "TAVILY_API_KEY";
export type LoadedKeys = {
  engine: EngineStartOptions;
  deepgramKey: string;
  missing: string[];
};

const keyNames = [
  "DEEPGRAM_API_KEY",
  "ANTHROPIC_API_KEY",
  "EXA_API_KEY",
  "TAVILY_API_KEY",
] as const;

export function loadKeys(
  env: Record<string, string | undefined>,
  searchKeyName: SearchKeyName,
): LoadedKeys {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = (env[name] ?? "").trim();
    if (value === "") missing.push(name);
    return value;
  };
  const deepgramKey = read("DEEPGRAM_API_KEY");
  const anthropicKey = read("ANTHROPIC_API_KEY");
  const searchKey = read(searchKeyName);
  // No key may reach a window or a child process, which inherit the environment.
  for (const name of keyNames) delete env[name];
  return { engine: { anthropicKey, searchKey }, deepgramKey, missing };
}
