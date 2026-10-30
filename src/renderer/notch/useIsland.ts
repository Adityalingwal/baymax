import { useEffect, useReducer } from "react";
import type { Dispatch } from "react";
import type { VoicePhase } from "../../shared/ipc";
import { initialIsland, islandDelays, islandReducer } from "./answer-island";
import type { IslandEvent, IslandState } from "./answer-island";

// The island's state from main's voice phase; eligible: the speaking line is a done task's result.
// Its timers are keyed by token, so a render never restarts them.
export function useIsland(
  phase: VoicePhase,
  eligible: boolean,
): { island: IslandState; dispatch: Dispatch<IslandEvent> } {
  const [island, dispatch] = useReducer(islandReducer, initialIsland);
  useEffect(
    () => dispatch({ kind: "phase", phase, eligible }),
    [phase, eligible],
  );
  const token = island.wait?.token ?? null;
  const kind = island.wait?.kind ?? null;
  useEffect(() => {
    if (token === null || kind === null) return;
    const ms = kind === "close" ? islandDelays.closeMs : islandDelays.closingMs;
    const event: IslandEvent = { kind: `${kind}-elapsed`, token };
    const timer = setTimeout(() => dispatch(event), ms);
    return () => clearTimeout(timer);
  }, [token, kind]);
  return { island, dispatch };
}

// What the island follows from the panel's own state, known only after the shape it depends on.
export function useIslandFollows(
  dispatch: Dispatch<IslandEvent>,
  panel: { open: boolean; inVisible: boolean },
): void {
  const { open, inVisible } = panel;
  useEffect(() => dispatch({ kind: "panel", open }), [dispatch, open]);
  useEffect(
    () => dispatch({ kind: "pointer", on: inVisible }),
    [dispatch, inVisible],
  );
}
