import type Anthropic from "@anthropic-ai/sdk";
import type {
  ModelCall,
  ModelOutcome,
  ModelRequest,
} from "../providers/anthropic";
import type { ContentsFn } from "../providers/page-contents";
import type { EngineEvent } from "../shared/engine";
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

// "waitForAbort" answers only when the call's signal aborts, as the real call does.
// A step may also be a function, called with the request, for a reply that reads it or a call that throws.
export type FakeStep =
  | ModelOutcome
  | "waitForAbort"
  | Promise<ModelOutcome>
  | ((request: ModelRequest) => ModelOutcome);

// The fixed parts of the default brief; its goal is the one in the request.
export const fakeBriefParts = {
  resultShape: "A short overview of its parts",
  sources: "Its official docs and repository",
  limits: "Leave out pricing",
};

// The two kinds of call the engine makes, told apart by the schema each asks for.
type CallKind = "brief" | "worker";

function schemaKeys(request: ModelRequest): string[] {
  const format = request.output_config?.format;
  if (format === undefined || format === null) return [];
  const { properties } = format.schema;
  return typeof properties === "object" && properties !== null
    ? Object.keys(properties)
    : [];
}

function kindOf(request: ModelRequest): CallKind {
  const keys = schemaKeys(request);
  return keys.includes("resultShape") ? "brief" : "worker";
}

const goalBlock = /<goal>\n([\s\S]*?)\n<\/goal>/;

function defaultBriefReply(request: ModelRequest): ModelOutcome {
  const content = request.messages[0].content;
  const goal = typeof content === "string" ? goalBlock.exec(content)?.[1] : "";
  const parts = { goal: goal ?? "", ...fakeBriefParts };
  return { ok: true, message: fakeMessage(JSON.stringify(parts)) };
}

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

// The scripted model: the steps are the worker's, in order; a brief writer request is answered from briefSteps, and by a valid brief when none is scripted.
// A request past the steps counts as missing, so settle fails and a missing step is never taken for the expected task error.
function scriptedModel(steps: FakeStep[], briefSteps: FakeStep[]) {
  const requests: ModelRequest[] = [];
  const clock = { now: 0, missing: 0 };
  const model: ModelCall = async (request, options) => {
    requests.push(structuredClone(request));
    clock.now += 250;
    const brief = kindOf(request) === "brief";
    const step = brief
      ? (briefSteps.shift() ?? defaultBriefReply)
      : steps.shift();
    if (step === undefined) {
      clock.missing += 1;
      throw new Error("no fake model step left");
    }
    if (step === "waitForAbort") return abortedWhen(options.signal);
    return typeof step === "function" ? step(request) : step;
  };
  const ofKind = (kind: CallKind) => () =>
    requests.filter((request) => kindOf(request) === kind);
  return {
    model,
    clock,
    requests, // every model call, in order
    briefRequests: ofKind("brief"),
    workerRequests: ofKind("worker"),
    // the worker's calls in order: every call but the brief writer's
    loopRequests: () =>
      requests.filter((request) => kindOf(request) !== "brief"),
  };
}

export function startTestEngine(
  steps: FakeStep[],
  fakes: EngineFakes = {},
  briefSteps: FakeStep[] = [],
) {
  const { model, clock, ...requests } = scriptedModel(steps, briefSteps);
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
  return { port, ...requests, entries, events, settle };
}
