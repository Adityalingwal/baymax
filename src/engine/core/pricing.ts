import type Anthropic from "@anthropic-ai/sdk";
import type { RoleModel } from "./limits";

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
