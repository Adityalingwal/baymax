import { describe, expect, it } from "vitest";
import type { LoadedKeys, SearchKeyName } from "./keys";
import { loadKeys } from "./keys";

type Row = {
  name: string;
  env: Record<string, string | undefined>;
  searchKeyName: SearchKeyName;
  expected: LoadedKeys;
};

const full = {
  DEEPGRAM_API_KEY: "  dg-key \n",
  ANTHROPIC_API_KEY: "ant-key",
  EXA_API_KEY: " exa-key ",
  TAVILY_API_KEY: "tavily-key",
  PATH: "/usr/bin",
};

const rows: Row[] = [
  {
    name: "values are trimmed and the Exa key is picked",
    env: { ...full },
    searchKeyName: "EXA_API_KEY",
    expected: {
      engine: { anthropicKey: "ant-key", searchKey: "exa-key" },
      deepgramKey: "dg-key",
      missing: [],
    },
  },
  {
    name: "the Tavily key is picked by its name",
    env: { ...full },
    searchKeyName: "TAVILY_API_KEY",
    expected: {
      engine: { anthropicKey: "ant-key", searchKey: "tavily-key" },
      deepgramKey: "dg-key",
      missing: [],
    },
  },
  {
    name: "missing and blank keys become empty and are listed",
    env: { DEEPGRAM_API_KEY: "   ", TAVILY_API_KEY: "tavily-key" },
    searchKeyName: "EXA_API_KEY",
    expected: {
      engine: { anthropicKey: "", searchKey: "" },
      deepgramKey: "",
      missing: ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "EXA_API_KEY"],
    },
  },
];

describe("loadKeys", () => {
  it.each(rows)("$name", ({ env, searchKeyName, expected }) => {
    expect(loadKeys({ ...env }, searchKeyName)).toEqual(expected);
  });

  it.each(rows)(
    "removes all four key names: $name",
    ({ env, searchKeyName }) => {
      const copy = { ...env };
      loadKeys(copy, searchKeyName);
      expect(
        Object.keys(copy).filter((name) => name.endsWith("_API_KEY")),
      ).toEqual([]);
    },
  );

  it("keeps other variables", () => {
    const env = { ...full };
    loadKeys(env, "EXA_API_KEY");
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  it("finds nothing on a second call", () => {
    const env = { ...full };
    loadKeys(env, "EXA_API_KEY");
    expect(loadKeys(env, "EXA_API_KEY")).toEqual({
      engine: { anthropicKey: "", searchKey: "" },
      deepgramKey: "",
      missing: ["DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "EXA_API_KEY"],
    });
  });
});
