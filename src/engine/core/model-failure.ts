import type { ModelFailure } from "../../providers/anthropic";
import type { FailureKind } from "../../shared/engine";

// What the user is told for a failed model call; null for a cancelled call, which says nothing.
export function failureKindOf(failure: ModelFailure): FailureKind | null {
  switch (failure) {
    case "aborted":
      return null;
    case "keyRejected":
      return "keyRejected";
    case "noCredit":
      return "noCredit";
    case "unreachable":
      return "modelsUnreachable";
    case "error":
      return "error";
  }
}
