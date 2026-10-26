import type {
  FailureKind,
  Incomplete,
  ProgressStep,
} from "../../shared/engine";

export const fixedLines = {
  letMeCheck: "Let me check.",
  queued: "Okay, I'll look at that after the current one.",
  queueFull: "I already have three waiting. Cancel one or ask again later.",
  outsideResearch: "I can't do that yet in this version.",
  wordsNotCaught: "I didn't catch that, say it again.",
  voiceUnavailable:
    "Voice isn't working right now. You can type your question instead.",
  restarting: "Baymax hit a problem and is restarting.",
} as const;

const failureLines: Record<FailureKind, string> = {
  modelsUnreachable:
    "I can't reach my models right now. Try again in a few minutes.",
  searchDown: "Search isn't working right now. Try again in a few minutes.",
  keyRejected:
    "Baymax's model service rejected its key. Please tell the person who set up Baymax.",
  noCredit:
    "Baymax's model service has no credit left. Please tell the person who set up Baymax.",
  error: "I hit an error on that question. Try again.",
};

export function failureLine(kind: FailureKind): string {
  return failureLines[kind];
}

export function taskShortForm(sayBack: string | null): string {
  const short = (sayBack ?? "").split(",")[0].trim();
  if (short === "") return "This task";
  return short[0].toUpperCase() + short.slice(1);
}

const partialEndings = {
  limitHit: "reached its limit",
  sourcesThin: "found little on the web",
  error: "hit an error",
} as const;

function partialLine(
  ending: keyof typeof partialEndings,
  task: string,
  found: boolean,
): string {
  const tail = found ? "; here is what I found." : " before it found anything.";
  return `${task} ${partialEndings[ending]}${tail}`;
}

type IncompleteLines = {
  line: string | null;
  missing: string | null;
  spoken: string;
};

export function incompleteLines(
  incomplete: Incomplete,
  sayBack: string | null,
): IncompleteLines {
  const task = taskShortForm(sayBack);
  const found = incomplete.findings !== null;
  switch (incomplete.kind) {
    case "needsUser":
      return {
        line: null,
        missing: incomplete.nextQuestion,
        spoken: incomplete.nextQuestion,
      };
    case "unchecked": {
      const line = `${task} is finished, but I couldn't check all of it; the unchecked part is marked.`;
      return { line, missing: incomplete.uncheckedPart, spoken: line };
    }
    case "error": {
      const line =
        incomplete.cause === "error"
          ? partialLine("error", task, found)
          : failureLine(incomplete.cause);
      return { line, missing: null, spoken: line };
    }
    default: {
      const line = partialLine(incomplete.kind, task, found);
      return { line, missing: null, spoken: line };
    }
  }
}

export function stepText(step: ProgressStep): string {
  if (step.tool === "search") return `searching: ${step.query}`;
  try {
    return `reading ${new URL(step.url).hostname}`;
  } catch {
    return `reading ${step.url}`;
  }
}
