import type {
  FailureCause,
  FailureKind,
  ProgressStep,
} from "../../shared/engine";

const keyLine =
  "One of my keys isn't working. Please check your env file and restart me.";

export const fixedLines = {
  wordsNotCaught: "I didn't catch that, say it again.",
  micBlocked:
    "I can't use the microphone. Allow Baymax in System Settings, Privacy and Security, Microphone, or type your question.",
  noMicrophone:
    "I can't find a microphone. Connect one, or type your question.",
  voiceUnavailable:
    "Voice isn't working right now. You can type your question instead.",
  keyMissing: keyLine,
  restarting: "Baymax hit a problem and is restarting.",
} as const;

const creditLine =
  "One of my accounts has run out of credit, so I can't help right now. Once it's topped up, I'm good to go.";

// What went wrong and what to do, in plain words: what a card shows and what the talker is told.
const causeLines: Record<FailureKind | "limitHit", string> = {
  modelsUnreachable:
    "I'm having a little trouble right now. Try me again in a few minutes.",
  searchDown: "I can't look that up right now. Ask me again in a few minutes.",
  searchKeyRejected: keyLine,
  searchQuota: creditLine,
  keyRejected: keyLine,
  noCredit: creditLine,
  error:
    "Something went wrong while I was working on that. Try me again in a bit.",
  // The event does not tell time, model-call and cost limits apart, so neither does the line.
  limitHit: "That one's a bit big for me. Can you ask about one part of it?",
};

// A failed task's cause: the worker's own sentence when it found nothing, else a fixed line naming the cause and the fix.
export function failedLine(cause: FailureCause, reason: string | null): string {
  if (cause === "nothingFound") return reason ?? causeLines.error;
  return causeLines[cause];
}

const keyStep =
  "Say one of your keys isn't working, and that they should check the env file and restart you. Don't offer to try again.";
const creditStep =
  "Say one of your accounts has run out of credit, and that you can't help until it's topped up. Don't offer to try again.";

const nextSteps: Record<Exclude<FailureCause, "error">, string> = {
  nothingFound:
    "Say you couldn't find it and ask for a detail or a different angle. Don't offer to try again.",
  modelsUnreachable:
    "Say you're having trouble right now and suggest a few minutes later. Don't offer to try again.",
  searchDown:
    "Say you can't look it up right now and suggest asking again in a few minutes. Don't offer to try again.",
  keyRejected: keyStep,
  searchKeyRejected: keyStep,
  noCredit: creditStep,
  searchQuota: creditStep,
  limitHit:
    "Say it's a bit big for you and ask them to ask about one part of it. Don't offer to try again.",
};

// What the talker is told to do after a failure; main decides, so a yes can never retry what trying again cannot fix.
export function failureNext(
  kind: FailureCause,
  retried: boolean,
): { nextStep: string; offersRetry: boolean } {
  if (kind !== "error") {
    return { nextStep: nextSteps[kind], offersRetry: false };
  }
  return retried
    ? {
        nextStep:
          "Say you couldn't get it done and make one short ask that fits the request. Don't offer to try again.",
        offersRetry: false,
      }
    : {
        nextStep:
          "Say something went wrong while you were working on it and ask if you should try once more.",
        offersRetry: true,
      };
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
