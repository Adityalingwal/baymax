import type {
  FailureCause,
  FailureKind,
  ProgressStep,
} from "../../shared/engine";

export const fixedLines = {
  wordsNotCaught: "I didn't catch that, say it again.",
  micBlocked:
    "I can't use the microphone. Allow Baymax in System Settings, Privacy and Security, Microphone, or type your question.",
  noMicrophone:
    "I can't find a microphone. Connect one, or type your question.",
  voiceUnavailable:
    "Voice isn't working right now. You can type your question instead.",
  restarting: "Baymax hit a problem and is restarting.",
} as const;

// What went wrong and what to do, in plain words: what a card shows and what the talker is told.
const causeLines: Record<FailureKind | "limitHit", string> = {
  modelsUnreachable:
    "I can't reach my models right now. Try again in a few minutes.",
  searchDown: "Search isn't working right now. Try again in a few minutes.",
  searchKeyRejected:
    "Baymax's search service rejected its key. Please tell the person who set up Baymax.",
  searchQuota:
    "Baymax's search service has reached its quota. Please tell the person who set up Baymax.",
  keyRejected:
    "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
  noCredit:
    "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
  error: "I hit an error on that question. Try again.",
  // The event does not tell time, model-call and cost limits apart, so neither does the line.
  limitHit:
    "That task reached a limit before it had an answer. Try a narrower question or try again.",
};

// A failed task's cause: the worker's own sentence when it found nothing, else a fixed line naming the cause and the fix.
export function failedLine(cause: FailureCause, reason: string | null): string {
  if (cause === "nothingFound") return reason ?? causeLines.error;
  return causeLines[cause];
}

// The line of a failed front call: a known cause names the fix; otherwise it depends on whether Baymax had already spoken. It never blames hearing.
export function frontFailureLine(kind: FailureKind, spoke: boolean): string {
  if (
    kind === "keyRejected" ||
    kind === "noCredit" ||
    kind === "modelsUnreachable"
  ) {
    return causeLines[kind];
  }
  return spoke
    ? "Something went wrong on my side, so nothing started. Ask again."
    : "Something went wrong on my side. Ask again.";
}

export function stepText(step: ProgressStep): string {
  if (step.tool === "search") return `searching: ${step.query}`;
  try {
    return `reading ${new URL(step.url).hostname}`;
  } catch {
    return `reading ${step.url}`;
  }
}
