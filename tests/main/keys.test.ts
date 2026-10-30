import { describe, expect, it } from "vitest";
import type { LoadedKeys } from "../../src/main/keys";
import { loadKeys } from "../../src/main/keys";

type Row = {
  name: string;
  env: Record<string, string | undefined>;
  expected: LoadedKeys;
};

const full = {
  DEEPGRAM_API_KEY: "  dg-key \n",
  ANTHROPIC_API_KEY: "ant-key",
  EXA_API_KEY: " exa-key ",
  TAVILY_API_KEY: "stale-tavily-key",
  PATH: "/usr/bin",
};

const rows: Row[] = [
  {
    name: "values are trimmed and the Exa key is the search key",
    env: { ...full },
    expected: {
      engine: { anthropicKey: "ant-key", searchKey: "exa-key" },
      deepgramKey: "dg-key",
      missing: [],
    },
  },
  {
    name: "missing and blank keys become empty and are listed",
    env: { DEEPGRAM_API_KEY: "   ", TAVILY_API_KEY: "stale-tavily-key" },
    expected: {
      engine: { anthropicKey: "", searchKey: "" },
      deepgramKey: "",
      missing: ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "EXA_API_KEY"],
    },
  },
];

describe("loadKeys", () => {
  it.each(rows)("$name", ({ env, expected }) => {
    expect(loadKeys({ ...env })).toEqual(expected);
  });

  it.each(rows)("removes every key, stale ones included: $name", ({ env }) => {
    const copy = { ...env };
    loadKeys(copy);
    expect(
      Object.keys(copy).filter((name) => name.endsWith("_API_KEY")),
    ).toEqual([]);
  });

  it("keeps other variables", () => {
    const env = { ...full };
    loadKeys(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("finds nothing on a second call", () => {
    const env = { ...full };
    loadKeys(env);
    expect(loadKeys(env)).toEqual({
      engine: { anthropicKey: "", searchKey: "" },
      deepgramKey: "",
      missing: ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "EXA_API_KEY"],
    });
  });
});
