import type {
  FailureKind,
  Incomplete,
  ParentResult,
  ProgressStep,
} from "../../shared/engine";

export const fixedLines = {
  queued: "Okay, I'll look at that after the current one.",
  queueFull: "I already have three waiting. Cancel one or ask again later.",
  wordsNotCaught: "I didn't catch that, say it again.",
  micBlocked:
    "I can't use the microphone. Allow Baymax in System Settings, Privacy and Security, Microphone, or type your question.",
  noMicrophone:
    "I can't find a microphone. Connect one, or type your question.",
  voiceUnavailable:
    "Voice isn't working right now. You can type your question instead.",
  restarting: "Baymax hit a problem and is restarting.",
  builtOnPartial: "Built on the partial findings of an earlier question.",
  frontMissed: "Sorry, I missed that. Ask again.",
  frontStalled: "That didn't go through. Ask again.",
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

// The line of a failed front call: setup problems name the fix; otherwise it depends on whether Baymax had already spoken.
export function frontFailureLine(kind: FailureKind, spoke: boolean): string {
  if (kind === "keyRejected" || kind === "noCredit") return failureLine(kind);
  return spoke ? fixedLines.frontStalled : fixedLines.frontMissed;
}

function topicShort(topic: string | null): string {
  return (topic ?? "").split(",")[0].trim();
}

export function taskShortForm(
  topic: string | null,
  fallback = "This task",
): string {
  const short = topicShort(topic);
  if (short === "") return fallback;
  return short[0].toUpperCase() + short.slice(1);
}

// The line of a follow-up whose parent did not end done; null for a done parent.
export function partialParentLine(
  parent: ParentResult,
  parentTopic: string | null,
): string | null {
  if (parent.outcome === "done") return null;
  const name = taskShortForm(parentTopic, "The earlier question");
  const found = parent.findings !== null;
  if (parent.outcome === "incomplete") {
    return found
      ? `${name} ended without a full answer, so I'll build on what it found.`
      : `${name} ended before it found anything.`;
  }
  return found
    ? `${name} was cancelled, so I'll build on what it found.`
    : `${name} was cancelled before it found anything.`;
}

const partialEndings = {
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

// A limit is never named: a found answer is said as the worker wrote it, with what it left open; otherwise the line says what was not found.
function limitLines(
  incomplete: Extract<Incomplete, { kind: "limitHit" }>,
  topic: string | null,
): IncompleteLines {
  const { findings, spokenLine } = incomplete;
  const subject = topicShort(topic) || "that";
  if (findings !== null && spokenLine !== undefined) {
    const open = findings.openPoints.join("; ");
    const missing = open === "" ? null : `Not found: ${open}`;
    return { line: null, missing, spoken: spokenLine };
  }
  const line =
    findings === null
      ? `I couldn't find an answer on ${subject}.`
      : `I couldn't finish an answer on ${subject}; here are the pages I read.`;
  return { line, missing: null, spoken: line };
}

export function incompleteLines(
  incomplete: Incomplete,
  topic: string | null,
): IncompleteLines {
  const task = taskShortForm(topic);
  const found = incomplete.findings !== null;
  switch (incomplete.kind) {
    case "limitHit":
      return limitLines(incomplete, topic);
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
