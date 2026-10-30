import type Anthropic from "@anthropic-ai/sdk";
import type {
  ModelCall,
  ModelOutcome,
  ModelRequest,
} from "../../src/providers/anthropic";
import type { ContentsFn } from "../../src/providers/exa";
import type { EngineEvent } from "../../src/shared/engine";
import type { DevLogEntry } from "../../src/engine/core/dev-log";
import { startEngine } from "../../src/engine/index";
import type { EngineFakes } from "../../src/engine/index";

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

// "waitForAbort" answers only when the call's signal aborts, as the real call does.
// A step may also be a function, called with the request, for a reply that reads it or a call that throws.
export type FakeStep =
  | ModelOutcome
  | "waitForAbort"
  | Promise<ModelOutcome>
  | ((request: ModelRequest) => ModelOutcome);

function abortedWhen(signal: AbortSignal): Promise<ModelOutcome> {
  const aborted: ModelOutcome = { ok: false, failure: "aborted", detail: "" };
  return new Promise((resolve) => {
    if (signal.aborted) resolve(aborted);
    signal.addEventListener("abort", () => resolve(aborted), { once: true });
  });
}

// Exa Contents has no text for any URL, so a read goes on to the fallback reader.
export const noContents: ContentsFn = async () => ({
  ok: false,
  cause: "noUsableText",
});

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

// The scripted model: the steps are the worker's, in order.
// A request past the steps counts as missing, so settle fails and a missing step is never taken for the expected task error.
function scriptedModel(steps: FakeStep[]) {
  const requests: ModelRequest[] = [];
  const clock = { now: 0, missing: 0 };
  const model: ModelCall = async (request, options) => {
    requests.push(structuredClone(request));
    clock.now += 250;
    const step = steps.shift();
    if (step === undefined) {
      clock.missing += 1;
      throw new Error("no fake model step left");
    }
    if (step === "waitForAbort") return abortedWhen(options.signal);
    return typeof step === "function" ? step(request) : step;
  };
  return { model, clock, requests };
}

export function startTestEngine(steps: FakeStep[], fakes: EngineFakes = {}) {
  const { model, clock, requests } = scriptedModel(steps);
  const entries: DevLogEntry[] = [];
  const events: EngineEvent[] = [];
  const log = (entry: DevLogEntry) => {
    entries.push(entry);
  };
  const keys = { anthropicKey: "test-key", searchKey: "" };
  const port = startEngine(keys, {
    today: () => "2026-10-27",
    now: () => clock.now,
    contents: noContents,
    ...fakes,
    model,
    log,
  });
  port.onMessage((event) => {
    events.push(event);
  });
  // Waits until the count arrived, then a few more turns so a stray extra event would show.
  const settle = async (count = 0) => {
    for (let turn = 0; turn < 100 && events.length < count; turn += 1) {
      await nextTurn();
    }
    for (let turn = 0; turn < 5; turn += 1) await nextTurn();
    if (clock.missing > 0)
      throw new Error(
        "the engine asked for more model steps than the test gave",
      );
    return events;
  };
  return { port, requests, entries, events, settle };
}
