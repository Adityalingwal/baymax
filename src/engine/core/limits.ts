import type Anthropic from "@anthropic-ai/sdk";

export const taskLimits = {
  modelCalls: 30,
  searches: 20,
  activeMs: 240_000,
  dollars: 0.5,
} as const;

export const roles = {
  worker: { model: "claude-sonnet-5-5", maxTokens: 2048, timeoutMs: 60_000 },
} as const;

export type Role = keyof typeof roles;

type RoleModel = (typeof roles)[Role]["model"];

export type TaskBudget = {
  modelCalls: number;
  activeMs: number;
  dollars: number;
};

export function createTaskBudget(): TaskBudget {
  return { modelCalls: 0, activeMs: 0, dollars: 0 };
}

type Price = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

// US dollars per million tokens, Claude API first-party rates; cache write is the 5-minute rate.
const prices: Record<RoleModel, Price> = {
  "claude-sonnet-5-5": {
    input: 2.0,
    output: 10.0,
    cacheWrite: 2.5,
    cacheRead: 0.2,
  },
};

type TokenCounts = Pick<Anthropic.Usage, "input_tokens" | "output_tokens"> &
  Partial<
    Pick<
      Anthropic.Usage,
      "cache_creation_input_tokens" | "cache_read_input_tokens"
    >
  >;

export function costOf(model: RoleModel, usage: TokenCounts): number {
  const price = prices[model];
  const microDollars =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead;
  return microDollars / 1_000_000;
}
