import type Anthropic from "@anthropic-ai/sdk";
import type {
  ModelCall,
  ModelOutcome,
  ModelRequest,
} from "../providers/anthropic";
import type { ContentsFn } from "../providers/page-contents";
import type { EngineCommand, EngineEvent } from "../shared/engine";
import type { DevLogEntry } from "./core/dev-log";
import { startEngine } from "./index";
import type { EngineFakes } from "./index";

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

type ReplyFields = Record<string, unknown>;

// A model answer to a question command; fields left out are null.
export function questionReply(fields: ReplyFields): ModelOutcome {
  const full = {
    sayBack: "what was asked",
    route: "newTask",
    parentTaskId: null,
    startLine: null,
    brief: null,
    clarify: null,
    reply: null,
    ...fields,
  };
  return { ok: true, message: fakeMessage(JSON.stringify(full)) };
}

// A model answer to a clarifying-answer command, whose schema has no clarify or reply.
export function answerReply(fields: ReplyFields): ModelOutcome {
  const full = {
    sayBack: "what was asked",
    route: "newTask",
    parentTaskId: null,
    startLine: null,
    brief: null,
    ...fields,
  };
  return { ok: true, message: fakeMessage(JSON.stringify(full)) };
}

export function question(
  words: string,
  extra: Partial<Extract<EngineCommand, { type: "question" }>> = {},
): EngineCommand {
  const base = { taskId: "task-1", utteranceId: null, words };
  return { type: "question", ...base, recent: [], waiting: null, ...extra };
}

// "waitForAbort" answers only when the call's signal aborts, as the real call does.
export type FakeStep = ModelOutcome | "waitForAbort" | Promise<ModelOutcome>;

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

// A test that runs out of model steps fails in settle, so a missing step is never taken for the expected task error.
export function startTestEngine(steps: FakeStep[], fakes: EngineFakes = {}) {
  const requests: ModelRequest[] = [];
  const entries: DevLogEntry[] = [];
  const events: EngineEvent[] = [];
  let clock = 0;
  let stepsMissing = 0;
  const model: ModelCall = async (request, options) => {
    requests.push(structuredClone(request));
    clock += 250;
    const step = steps.shift();
    if (step === undefined) {
      stepsMissing += 1;
      throw new Error("no fake model step left");
    }
    return step === "waitForAbort" ? abortedWhen(options.signal) : step;
  };
  const log = (entry: DevLogEntry) => {
    entries.push(entry);
  };
  const keys = { anthropicKey: "test-key", searchKey: "" };
  const port = startEngine(keys, {
    today: () => "2026-10-27",
    now: () => clock,
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
    if (stepsMissing > 0)
      throw new Error(
        "the engine asked for more model steps than the test gave",
      );
    return events;
  };
  return { port, requests, entries, events, settle };
}
