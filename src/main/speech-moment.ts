import type { Line, SpeechContext } from "./speech-model";
import { endPlaying, log } from "./speech-model";
import { fixedLines } from "./tasks/lines";

// A talker line of this generation that already has words, waiting, synthesizing or playing.
function talkerHasWords(ctx: SpeechContext, key: string): boolean {
  const { pending, synthesizing, playing } = ctx.state;
  const lines = [...pending, synthesizing?.line, playing?.line];
  return lines.some(
    (line) =>
      line?.kind === "talk" && line.key === key && line.feed.text.trim() !== "",
  );
}

// Its generation ended or its talker has words: its "One moment." with no audio yet goes.
export function dropMoment(ctx: SpeechContext, key: string): void {
  const { state } = ctx;
  const ours = (line: Line) => line.kind === "moment" && line.key === key;
  const before = state.pending.length;
  state.pending = state.pending.filter((line) => !ours(line));
  let dropped = state.pending.length < before;
  const job = state.synthesizing;
  if (job !== null && ours(job.line)) {
    state.synthesizing = null;
    job.abort.abort();
    dropped = true;
  }
  const playing = state.playing;
  if (playing !== null && ours(playing.line) && playing.stream?.seq === 0) {
    endPlaying(ctx, playing.lineId);
    dropped = true;
  }
  if (!dropped) return;
  log('"One moment." dropped before its audio');
  ctx.pump();
}

// "One moment." plays ahead of the lines waiting, but never delays a talker that already has words.
export function sayMoment(ctx: SpeechContext, key: string): void {
  const { state } = ctx;
  if (state.muted) return log("line dropped: muted (moment)");
  if (talkerHasWords(ctx, key)) {
    return log('"One moment." skipped: the talker has words');
  }
  const text = fixedLines.oneMoment;
  const feed = { text, ended: true, changed: null };
  state.pending.unshift({ taskId: null, kind: "moment", key, feed });
  ctx.pump();
}
