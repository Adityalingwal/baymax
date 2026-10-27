import type Anthropic from "@anthropic-ai/sdk";

type MessageParts = {
  stopReason?: Anthropic.Message["stop_reason"];
  usage?: Partial<Anthropic.Usage>;
};

// A Messages API response with one text block, as the SDK returns it.
export function fakeMessage(
  text: string,
  parts: MessageParts = {},
): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    container: null,
    diagnostics: null,
    content: [{ type: "text", text, citations: null }],
    stop_reason: parts.stopReason ?? "end_turn",
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      ...parts.usage,
    },
  };
}
