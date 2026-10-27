import Anthropic from "@anthropic-ai/sdk";

export type ModelRequest = Anthropic.MessageCreateParamsNonStreaming;

export type ModelFailure =
  "keyRejected" | "noCredit" | "unreachable" | "aborted" | "error";

export type ModelOutcome =
  | { ok: true; message: Anthropic.Message }
  | { ok: false; failure: ModelFailure; detail: string }; // detail goes only to the dev log

export type ModelCall = (
  request: ModelRequest,
  options: { timeoutMs: number; deadlineMs: number; signal: AbortSignal }, // timeoutMs per attempt; deadlineMs for the whole call
) => Promise<ModelOutcome>;

const transportCodes = new Set([
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const unreachableStatuses = new Set([408, 409, 429, 529]);

function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    if ("code" in current && typeof current.code === "string") {
      codes.push(current.code);
    }
    if (!("cause" in current)) break;
    current = current.cause;
  }
  return codes;
}

function mapApiError(
  error: InstanceType<typeof Anthropic.APIError>,
): ModelFailure {
  const status = error.status;
  if (error.type === "billing_error" || status === 402) return "noCredit";
  if (status === 401 || status === 403) return "keyRejected";
  if (
    status !== undefined &&
    (unreachableStatuses.has(status) || status >= 500)
  ) {
    return "unreachable";
  }
  return "error";
}

// The SDK's abort and connection classes extend APIError, so they are tested first.
function mapError(error: unknown): ModelFailure {
  if (error instanceof Anthropic.APIUserAbortError) return "aborted";
  if (error instanceof Anthropic.APIConnectionError) return "unreachable";
  if (error instanceof Anthropic.APIError) return mapApiError(error);
  if (causeCodes(error).some((code) => transportCodes.has(code))) {
    return "unreachable";
  }
  return "error";
}

function describeError(error: unknown, apiKey: string): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.constructor.name);
    if (error instanceof Anthropic.APIError) {
      parts.push(
        `status=${String(error.status)}`,
        `type=${String(error.type)}`,
        `requestID=${String(error.requestID)}`,
      );
    }
    parts.push(error.message);
  } else {
    parts.push(String(error));
  }
  const code = causeCodes(error)[0];
  if (code !== undefined) parts.push(`code=${code}`);
  const line = parts.join(" ").replace(/\s+/g, " ").trim();
  return apiKey === "" ? line : line.split(apiKey).join("[key]");
}

export function createModelCall(params: {
  apiKey: string;
  fetch?: typeof fetch;
}): ModelCall {
  const client = new Anthropic({
    apiKey: params.apiKey,
    fetch: params.fetch,
    maxRetries: 1,
    logLevel: "off", // ANTHROPIC_LOG=debug would print request bodies, user words included
  });
  return async (request, options) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), options.deadlineMs);
    const combined = AbortSignal.any([options.signal, deadline.signal]);
    try {
      const message = await client.messages.create(request, {
        timeout: options.timeoutMs,
        signal: combined,
      });
      return { ok: true, message };
    } catch (error) {
      const failure: ModelFailure = options.signal.aborted
        ? "aborted"
        : deadline.signal.aborted
          ? "unreachable"
          : mapError(error);
      return {
        ok: false,
        failure,
        detail: describeError(error, params.apiKey),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
