import { useEffect, useReducer, useRef } from "react";
import type { Dispatch } from "react";
import type { TaskCard } from "../../shared/cards";
import { initialIsland, islandDelays, islandReducer } from "./answer-island";
import type { IslandEvent, IslandState } from "./answer-island";
import { isAnswerLine } from "./views";

function useFoldOnEscape(
  reportOpen: boolean,
  dispatch: Dispatch<IslandEvent>,
): void {
  useEffect(() => {
    if (!reportOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ kind: "fold" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reportOpen, dispatch]);
}

// The island's state and its report to main. Its timers are keyed by token, so a render never restarts them.
export function useIsland(tasks: readonly TaskCard[]): {
  island: IslandState;
  dispatch: Dispatch<IslandEvent>;
} {
  const [island, dispatch] = useReducer(islandReducer, initialIsland);
  const latestTasks = useRef(tasks);
  latestTasks.current = tasks;
  // Every phase reaches the reducer, not only the last before a render: a result line missed here would leave main waiting for its report for good.
  useEffect(
    () =>
      window.baymax.onVoicePhase((phase) =>
        dispatch({
          kind: "phase",
          phase,
          eligible: isAnswerLine(phase, latestTasks.current),
        }),
      ),
    [],
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
  const { closed, reportOpen } = island;
  useEffect(() => {
    if (closed !== null) window.baymax.reportIslandClosed({ lineId: closed });
  }, [closed]);
  useFoldOnEscape(reportOpen, dispatch);
  return { island, dispatch };
}

// What the island follows from the panel's own state, known only after the shape it depends on.
export function useIslandFollows(
  dispatch: Dispatch<IslandEvent>,
  panel: { open: boolean; hovering: boolean },
): void {
  const { open, hovering } = panel;
  useEffect(() => dispatch({ kind: "panel", open }), [dispatch, open]);
  useEffect(
    () => dispatch({ kind: "pointer", on: hovering }),
    [dispatch, hovering],
  );
}
