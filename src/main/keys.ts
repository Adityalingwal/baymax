import type { EngineStartOptions } from "../shared/engine";

export type LoadedKeys = {
  engine: EngineStartOptions;
  deepgramKey: string;
  missing: string[];
};

export function loadKeys(env: Record<string, string | undefined>): LoadedKeys {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = (env[name] ?? "").trim();
    if (value === "") missing.push(name);
    return value;
  };
  const deepgramKey = read("DEEPGRAM_API_KEY");
  const anthropicKey = read("ANTHROPIC_API_KEY");
  const searchKey = read("EXA_API_KEY");
  // No key may reach a window or a child process, which inherit the environment;
  // the suffix also catches stale keys such as an old TAVILY_API_KEY line.
  for (const name of Object.keys(env)) {
    if (name.endsWith("_API_KEY")) delete env[name];
  }
  return { engine: { anthropicKey, searchKey }, deepgramKey, missing };
}
