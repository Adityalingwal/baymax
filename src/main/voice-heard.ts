import type { Heard, NotCaughtCause } from "./recording";
import type { PhaseTracker } from "./voice-phase";
import { setStt } from "./voice-model";
import type { VoiceModel, VoiceState } from "./voice-model";

type HeardDeps = { now: () => number; log: (message: string) => void };

function notCaught(
  model: VoiceModel,
  deps: HeardDeps,
  state: VoiceState,
  cause: NotCaughtCause,
  order: number,
): void {
  switch (cause) {
    case "empty":
      setStt(model, deps.log, true, order);
      return state.showNotice("wordsNotCaught");
    case "error":
      return state.showNotice("wordsNotCaught");
    case "unreachable":
    case "keyRejected":
    case "noCredit":
      return setStt(model, deps.log, false, order);
    case "permissionDenied":
      return state.showNotice("micBlocked");
    case "noMicrophone":
      return state.showNotice("noMicrophone");
  }
}

// A held utterance's result: its words go to main's state; a miss shows its line and ends the pending turn.
export function receiveHeard(
  model: VoiceModel,
  deps: HeardDeps,
  phases: PhaseTracker,
  heard: Heard,
): void {
  const entry = model.admitted.get(heard.utteranceId);
  const state = model.state;
  if (entry === undefined || state === null) {
    deps.log(`${heard.kind} dropped: utterance not admitted`);
    phases.turnEnded(heard.utteranceId);
    return;
  }
  model.admitted.delete(heard.utteranceId);
  if (entry.releasedAt !== null) {
    const ms = Math.round(deps.now() - entry.releasedAt);
    deps.log(`final transcript ${ms} ms after release`);
  }
  if (heard.kind === "notCaught") {
    phases.turnEnded(heard.utteranceId);
    return notCaught(model, deps, state, heard.cause, entry.order);
  }
  setStt(model, deps.log, true, entry.order);
  state.ask(heard.words, heard.utteranceId, entry.waiting);
  phases.asked(heard.utteranceId);
}
