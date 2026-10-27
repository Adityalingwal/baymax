import type { EnginePort } from "../../shared/engine";
import { startEngine } from "../../engine/index";
import type { EngineFakes } from "../../engine/index";

type ModelCall = NonNullable<EngineFakes["model"]>;
export type ModelRequest = Parameters<ModelCall>[0];
export type Outcome = Awaited<ReturnType<ModelCall>>;
type Message = Extract<Outcome, { ok: true }>["message"];

// A step answers one model call: a fixed outcome, or a call that decides when and what to answer.
type Step = Outcome | ModelCall;

// A Messages API response with one JSON text block, as the SDK returns it.
export function reply(fields: Record<string, unknown>): Outcome {
  const message: Message = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    container: null,
    diagnostics: null,
    content: [{ type: "text", text: JSON.stringify(fields), citations: null }],
    stop_reason: "end_turn",
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
    },
  };
  return { ok: true, message };
}

export const briefParts = (goal: string) => ({
  goal,
  resultShape: "a short answer",
  sources: "the web",
  limits: "normal",
});

// An intake reply to a question command: all seven fields, unused ones null.
export const questionReply = (fields: Record<string, unknown>): Outcome =>
  reply({
    sayBack: "what was asked",
    route: "newTask",
    parentTaskId: null,
    startLine: null,
    brief: null,
    clarify: null,
    reply: null,
    ...fields,
  });

// A newTask intake reply with its start line and brief.
export const newTaskReply = (sayBack: string): Outcome =>
  questionReply({
    sayBack,
    startLine: `Okay, looking at ${sayBack}.`,
    brief: briefParts(sayBack),
  });

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

function fakeModel(steps: Step[]) {
  const requests: ModelRequest[] = [];
  const model: ModelCall = async (request, options) => {
    requests.push(structuredClone(request));
    const step = steps.shift();
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
export function startFakeEngine(steps: Step[]) {
  const { model, requests } = fakeModel(steps);
  const port = startEngine(
    { anthropicKey: "test-key", searchKey: "" },
    { model, today: () => "2026-10-27", now: () => 0, log: () => undefined },
  );
  ports.push(port);
  return { port, requests };
}

export function closePorts(): void {
  for (const port of ports.splice(0)) port.close();
}
