import type Anthropic from "@anthropic-ai/sdk";

// The worker's only tools, both from the one web tool; the list never changes, so the prompt start stays cached.
export const researchTools: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "Search the web. Returns titles, URLs and snippets; snippets cannot be cited, so read a page to cite it.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description:
      "Read one web page by its URL. Returns its text with a source id you can cite.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http or https URL to read." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export type ResearchCall =
  | { id: string; tool: "search"; query: string }
  | { id: string; tool: "read"; url: string };

function onlyString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== key) return null;
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

function callFrom(block: Anthropic.ToolUseBlock): ResearchCall | null {
  if (block.name === "search") {
    const query = onlyString(block.input, "query");
    return query === null ? null : { id: block.id, tool: "search", query };
  }
  if (block.name === "read") {
    const url = onlyString(block.input, "url");
    return url === null ? null : { id: block.id, tool: "read", url };
  }
  return null;
}

// Tool input is unchecked model output: one unknown tool or malformed argument rejects the whole turn.
export function parseCalls(
  blocks: Anthropic.ToolUseBlock[],
): ResearchCall[] | null {
  const calls = blocks.map(callFrom);
  return calls.every((call) => call !== null) ? calls : null;
}
