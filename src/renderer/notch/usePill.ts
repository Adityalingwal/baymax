import { useEffect, useReducer } from "react";
import type { Dispatch } from "react";
import type { VoicePhase } from "../../shared/ipc";
import { initialPill, pillDelays, pillReducer } from "./pill";
import type { PillEvent, PillState } from "./pill";

// The pill's state from main's voice phase; answer: the speaking line is a done task's result, for the island.
// Its two timers are keyed by token, so a render never restarts them.
export function usePill(
  phase: VoicePhase,
  answer: boolean,
  muted: boolean,
): {
  pill: PillState;
  dispatch: Dispatch<PillEvent>;
} {
  const [pill, dispatch] = useReducer(pillReducer, initialPill);
  // Its own event, and first: resending the phase on a mute change would restart the pill's word and timers.
  useEffect(() => dispatch({ kind: "main-muted", muted }), [muted]);
  useEffect(() => dispatch({ kind: "phase", phase, answer }), [phase, answer]);
  const wait = pill.wait;
  const token = wait?.token ?? null;
  const kind = wait?.kind ?? null;
  useEffect(() => {
    if (token === null || kind === null) return;
    const ms =
      kind === "threshold" ? pillDelays.thresholdMs : pillDelays.holdMs;
    const event: PillEvent =
      kind === "threshold"
        ? { kind: "threshold-elapsed", token }
        : { kind: "hold-elapsed", token };
    const timer = setTimeout(() => dispatch(event), ms);
    return () => clearTimeout(timer);
  }, [token, kind]);
  return { pill, dispatch };
}
