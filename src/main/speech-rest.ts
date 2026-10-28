import type { Synthesis } from "../providers/deepgram";
import type { Job, SpeechContext } from "./speech-model";
import {
  describeError,
  endPlaying,
  guarded,
  log,
  occupy,
  voiceBack,
} from "./speech-model";
import type { SaidLine } from "./tasks/state";

type Audio = Extract<Synthesis, { kind: "audio" }>;
type Failed = Extract<Synthesis, { kind: "failed" }>;

function startPlaying(ctx: SpeechContext, line: SaidLine, result: Audio) {
  const playing = occupy(ctx, line, null);
  if (playing === null) return ctx.pump();
  const { lineId } = playing;
  const { audio, mimeType } = result;
  const sent = guarded("sendSpeech", () =>
    ctx.deps.sendSpeech({ lineId, audio, mimeType }),
  );
  if (!sent && endPlaying(ctx, lineId)) ctx.pump();
}

function synthesisFailed(ctx: SpeechContext, failure: Failed): void {
  if (failure.cause === "error") {
    log(`line dropped: synthesis error ${failure.detail}`);
    return;
  }
  const cause = failure.cause;
  log(`line dropped: voice down (${cause}) ${failure.detail}`);
  if (!ctx.state.voiceAvailable) return;
  ctx.state.voiceAvailable = false;
  guarded("onVoiceAvailable", () => ctx.deps.onVoiceAvailable(false, cause));
}

function synthesisSettled(
  ctx: SpeechContext,
  job: Job,
  result: Synthesis,
  startedAt: number,
): void {
  if (ctx.state.synthesizing !== job) return;
  ctx.state.synthesizing = null;
  log(`synthesis in ${Math.round(performance.now() - startedAt)} ms`);
  if (result.kind === "failed") {
    synthesisFailed(ctx, result);
    ctx.pump();
    return;
  }
  startPlaying(ctx, job.line, result);
  voiceBack(ctx);
}

// The REST call: the whole line is synthesized, then sent to the renderer as one clip.
export function startRest(ctx: SpeechContext, line: SaidLine): void {
  const job: Job = { line, abort: new AbortController() };
  ctx.state.synthesizing = job;
  const startedAt = performance.now();
  const settle = (result: Synthesis) =>
    synthesisSettled(ctx, job, result, startedAt);
  // Wrapped so a synchronous throw takes the same path as a rejection.
  new Promise<Synthesis>((resolve) =>
    resolve(ctx.deps.synthesize(line.text, job.abort.signal)),
  )
    .then(settle, (error: unknown) =>
      settle({ kind: "failed", cause: "error", detail: describeError(error) }),
    )
    .catch((error: unknown) => {
      log(`settling a synthesis threw: ${describeError(error)}`);
    });
}
