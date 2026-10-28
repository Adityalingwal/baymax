import { auraSampleRate } from "../providers/aura";
import type { Aura, AuraEvent } from "../providers/aura";
import { takeClauses } from "./clauses";
import type { SpeechContext, StreamJob } from "./speech-model";
import { endPlaying, guarded, log, occupy, voiceBack } from "./speech-model";
import { startRest } from "./speech-rest";
import type { SaidLine } from "./tasks/state";

// Every send is checked; false means the socket failed and the line takes the socket-failure path.
function speak(aura: Aura, stream: StreamJob, clauses: string[]): boolean {
  for (const clause of clauses) {
    if (!aura.speak(clause)) return false;
    stream.spokeSinceFlush = true;
    // The first clause is flushed at once, so its audio starts while the rest is written.
    if (stream.flushesSent === 0 && !flush(aura, stream)) return false;
  }
  return true;
}

function flush(aura: Aura, stream: StreamJob): boolean {
  stream.flushesSent += 1;
  stream.spokeSinceFlush = false;
  return aura.flush();
}

// Text goes out clause by clause; Flush only after the first clause and at the end, at most two per line.
function feed(aura: Aura, stream: StreamJob, text: string): boolean {
  const { clauses } = takeClauses(text, true);
  if (!speak(aura, stream, clauses)) return false;
  stream.textEnded = true;
  return !stream.spokeSinceFlush || flush(aura, stream);
}

function audioDone(ctx: SpeechContext): void {
  const playing = ctx.state.playing;
  const stream = playing?.stream ?? null;
  if (playing === null || stream === null) return;
  if (!stream.textEnded || stream.flushesDone < stream.flushesSent) return;
  playing.stream = null;
  const { lineId } = playing;
  guarded("sendEnd", () => ctx.deps.sendEnd({ lineId }));
}

// The line streams over the open socket; its audio goes to the renderer chunk by chunk.
export function startStream(
  ctx: SpeechContext,
  aura: Aura,
  line: SaidLine,
): void {
  const stream: StreamJob = {
    seq: 0,
    flushesSent: 0,
    flushesDone: 0,
    spokeSinceFlush: false,
    textEnded: false,
  };
  if (occupy(ctx, line, stream) === null) return ctx.pump();
  if (!feed(aura, stream, line.text)) return sendFailed(ctx, aura);
  audioDone(ctx);
}

// Chunks and Flushed carry no line id, so they belong to the line streaming now.
export function auraHeard(ctx: SpeechContext, event: AuraEvent): void {
  const playing = ctx.state.playing;
  const stream = playing?.stream ?? null;
  if (event.kind === "other") return log(`speech socket: ${event.summary}`);
  if (playing === null || stream === null) {
    return log(`speech socket ${event.kind} dropped: no line streaming`);
  }
  if (event.kind === "flushed") {
    stream.flushesDone += 1;
    return audioDone(ctx);
  }
  const { lineId } = playing;
  const chunk = { lineId, seq: stream.seq, pcm: event.pcm };
  stream.seq += 1;
  guarded("sendChunk", () =>
    ctx.deps.sendChunk({ ...chunk, sampleRate: auraSampleRate }),
  );
  voiceBack(ctx);
}

// A failed send restarts the socket like a cut line, so no event of the old socket binds to a later line.
function sendFailed(ctx: SpeechContext, aura: Aura): void {
  log("a speech socket send failed; the socket restarts");
  aura.restart();
  // The restart's close already ran the line's fallback if the socket was open; otherwise it runs here.
  auraClosed(ctx);
}

// A line that had no audio yet goes to REST whole; one that had some ends where it is, never replayed.
export function auraClosed(ctx: SpeechContext): void {
  const playing = ctx.state.playing;
  const stream = playing?.stream ?? null;
  if (playing === null || stream === null) return;
  playing.stream = null;
  const { lineId, line } = playing;
  if (stream.seq > 0) {
    log("speech socket closed mid-line: the rest of the line is dropped");
    guarded("sendEnd", () => ctx.deps.sendEnd({ lineId }));
    return;
  }
  log("speech socket closed before any audio: the line goes to REST");
  endPlaying(ctx, lineId);
  startRest(ctx, line);
}
