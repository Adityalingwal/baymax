import { useEffect, useReducer } from "react";
import type { HoldState } from "../../shared/ipc";
import { initialVoice, voiceReducer, voiceTiming } from "./shell";
import type { VoiceEvent } from "./shell";

// True once a hold has lasted past the tap threshold, and for a short linger after it ends.
export function useVoice(hold: HoldState): boolean {
  const [state, dispatch] = useReducer(voiceReducer, initialVoice);

  useEffect(() => {
    dispatch({
      kind: hold === "listening" ? "listening-started" : "listening-ended",
    });
  }, [hold]);

  useEffect(() => {
    if (state.listening === state.voice) return;
    const event: VoiceEvent = state.listening
      ? { kind: "threshold-elapsed", hold: state.hold }
      : { kind: "linger-elapsed", hold: state.hold };
    const delay = state.listening
      ? voiceTiming.thresholdMs
      : voiceTiming.lingerMs;
    const timer = setTimeout(() => dispatch(event), delay);
    return () => clearTimeout(timer);
  }, [state]);

  return state.voice;
}
