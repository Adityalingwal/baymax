import type { Line, SpeechContext } from "./speech-model";
import { endPlaying, log } from "./speech-model";
import { fixedLines } from "./tasks/lines";

// A talker line of this generation that holds the slot with no audio yet goes back to wait.
function takeBack(ctx: SpeechContext, key: string): Line | null {
  const { state } = ctx;
  const ours = (line: Line) => line.kind === "talk" && line.key === key;
  const job = state.synthesizing;
  if (job !== null && ours(job.line)) {
    state.synthesizing = null;
    job.abort.abort();
    job.line.feed.changed = ctx.pump;
    return job.line;
  }
  const playing = state.playing;
  if (playing === null || !ours(playing.line)) return null;
  if (playing.stream === null || playing.stream.seq > 0) return null;
  endPlaying(ctx, playing.lineId);
  playing.line.feed.changed = ctx.pump;
  return playing.line;
}

// "One moment." plays ahead of the lines waiting, its generation's talker line right after it.
export function sayMoment(ctx: SpeechContext, key: string): void {
  const { state } = ctx;
  if (state.muted) return log("line dropped: muted (moment)");
  const back = takeBack(ctx, key);
  if (back !== null) {
    log('the talker line waits for "One moment."');
    state.pending.unshift(back);
  }
  const text = fixedLines.oneMoment;
  const feed = { text, ended: true, changed: null };
  state.pending.unshift({ taskId: null, kind: "moment", key, feed });
  ctx.pump();
}
