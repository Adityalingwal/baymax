import { fixedLines } from "./lines";
import type { Change, Model } from "./record";
import { dropped, say } from "./record";

export type Notice =
  "wordsNotCaught" | "micBlocked" | "noMicrophone" | "restarting";

const oneOffLines: readonly string[] = [
  fixedLines.wordsNotCaught,
  fixedLines.micBlocked,
  fixedLines.noMicrophone,
];

// Restarting outranks voice unavailable, which outranks the one-off lines; among those the last one wins.
function rank(notice: string | null): number {
  if (notice === fixedLines.restarting) return 3;
  if (notice === fixedLines.voiceUnavailable) return 2;
  return notice === null ? 0 : 1;
}

export function showNotice(change: Change, notice: Notice): boolean {
  const { model } = change;
  const line = fixedLines[notice];
  if (model.notice === fixedLines.restarting) {
    return dropped(change, `notice ${notice} after restarting`);
  }
  if (rank(model.notice) > rank(line)) {
    return dropped(change, `notice ${notice} under a higher notice`);
  }
  model.notice = line;
  say(change, null, line, "notice");
  return true;
}

export function setVoiceAvailable(change: Change, available: boolean): boolean {
  const { model } = change;
  if (model.voiceAvailable === available) {
    return dropped(change, "same voice availability");
  }
  model.voiceAvailable = available;
  const downLine = fixedLines.voiceUnavailable;
  if (!available && rank(model.notice) < rank(downLine)) {
    model.notice = downLine;
    say(change, null, downLine, "notice");
  }
  if (available && model.notice === downLine) model.notice = null;
  return true;
}

// A question was asked, so a one-off line has done its job; voice unavailable stays while voice is down.
export function clearOneOffNotice(model: Model): void {
  if (model.notice === null || !oneOffLines.includes(model.notice)) return;
  model.notice = model.voiceAvailable ? null : fixedLines.voiceUnavailable;
}
