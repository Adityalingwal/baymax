import type { EnginePort } from "../../../src/shared/engine";
import { startEngine } from "../../../src/engine/index";
import type { EngineFakes } from "../../../src/engine/index";

type ModelCall = NonNullable<EngineFakes["model"]>;
export type ModelRequest = Parameters<ModelCall>[0];
export type Outcome = Awaited<ReturnType<ModelCall>>;

// A step answers one model call: a fixed outcome, or a call that decides when and what to answer.
type Step = Outcome | ModelCall;

// How the real model call reports a network failure.
export const unreachable: Outcome = {
  ok: false,
  failure: "unreachable",
  detail: "x",
};

// How the real model call reports a caller abort.
const aborted: Outcome = { ok: false, failure: "aborted", detail: "aborted" };

// A call that answers only when the test releases it, after its abort, as a slow network would.
export function heldStep() {
  const seen = { started: false, aborted: false };
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  const call: ModelCall = async (_request, { signal }) => {
    seen.started = true;
    const markAborted = () => (seen.aborted = true);
    if (signal.aborted) markAborted();
    else signal.addEventListener("abort", markAborted, { once: true });
    await released;
    return aborted;
  };
  return { call, seen, release: () => release() };
}

// A brief writer request asks for the four-part schema; main's tests may not import the engine's prompt to tell it.
function isBriefRequest(request: ModelRequest): boolean {
  const properties = request.output_config?.format?.schema.properties;
  return typeof properties === "object" && properties !== null
    ? "resultShape" in properties
    : false;
}

const goalBlock = /<goal>\n([\s\S]*?)\n<\/goal>/;

// The default brief writer answers a valid brief whose goal is the one in the request.
const briefReply: ModelCall = async (request) => {
  const content = request.messages[0]?.content;
  const goal = typeof content === "string" ? goalBlock.exec(content)?.[1] : "";
  const parts = {
    goal: goal ?? "",
    resultShape: "a short answer",
    sources: "the web",
    limits: "normal",
  };
  const text = JSON.stringify(parts);
  return {
    ok: true,
    message: {
      id: "msg_brief",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      container: null,
      diagnostics: null,
      content: [{ type: "text", text, citations: null }],
      stop_reason: "end_turn",
      stop_details: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
    },
  };
};

// The steps are the worker's; a brief writer request is answered from briefSteps, else by a valid brief.
function fakeModel(steps: Step[], briefSteps: Step[]) {
  const requests: ModelRequest[] = [];
  const model: ModelCall = async (request, options) => {
    requests.push(structuredClone(request));
    const brief = isBriefRequest(request);
    const step = brief ? (briefSteps.shift() ?? briefReply) : steps.shift();
    if (step === undefined) throw new Error("no fake model step left");
    return typeof step === "function" ? step(request, options) : step;
  };
  return { model, requests };
}

export const nextTurn = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

export async function until(what: string, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !done(); turn += 1) await nextTurn();
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

const ports: EnginePort[] = [];

// The real engine with only the model faked; closePorts ends it after the test.
export function startFakeEngine(steps: Step[], briefSteps: Step[] = []) {
  const { model, requests } = fakeModel(steps, briefSteps);
  const port = startEngine(
    { anthropicKey: "test-key", searchKey: "" },
    {
      model,
      contents: async () => ({ ok: false, cause: "noUsableText" }),
      today: () => "2026-10-27",
      now: () => 0,
      log: () => undefined,
    },
  );
  ports.push(port);
  const workerRequests = () =>
    requests.filter((request) => !isBriefRequest(request));
  return { port, requests, workerRequests };
}

export function closePorts(): void {
  for (const port of ports.splice(0)) port.close();
}
