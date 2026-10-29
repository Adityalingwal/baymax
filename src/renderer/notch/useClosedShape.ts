import { useCallback, useMemo, useRef, useState } from "react";
import type { TaskCard } from "../../shared/cards";
import type { WindowShape } from "../../shared/ipc";
import type { IslandSize } from "./Island";
import { notchSilhouette, panelShape } from "./outline";
import type { Silhouette } from "./outline";
import { islandShown } from "./pill";
import type { PillState } from "./pill";
import { ringSilhouette } from "./RunningRing";
import { closedView, islandLayout, islandWidth, runningCount } from "./views";
import type { ClosedView } from "./views";
import { pillShape } from "./VoicePill";

type IslandCard = Pick<TaskCard, "taskId" | "words" | "spokenLine">;

export type ClosedShape = {
  view: ClosedView;
  shape: Silhouette;
  running: number;
  island: { card: IslandCard | null; width: number };
  onIslandSize: (size: IslandSize) => void;
};

function islandSilhouette(width: number, cardHeight: number): Silhouette {
  const { strip, gap, bottom } = islandLayout;
  const { ear, rx, ry } = panelShape;
  // Never shorter than the strip and its corners, so the shape is valid before the card is measured.
  const height = Math.max(strip + gap + cardHeight + bottom, strip + ry);
  return { width, height, ear, rx, ry };
}

function silhouetteFor(
  view: ClosedView,
  shape: WindowShape,
  island: Silhouette,
): Silhouette {
  switch (view) {
    case "island":
      return island;
    case "pill":
      return pillShape;
    case "ring":
      return ringSilhouette(shape);
    case "notch":
      return notchSilhouette(shape);
  }
}

// What the closed notch shows and its shape; wide: the panel's body width, for an island whose line needs four lines.
export function useClosedShape(
  pill: PillState,
  tasks: readonly TaskCard[],
  frame: { shape: WindowShape; wide: number },
): ClosedShape {
  const [size, setSize] = useState<IslandSize>({
    cardHeight: 0,
    linesAt480: 1,
  });
  const onIslandSize = useCallback((next: IslandSize) => {
    setSize((now) =>
      now.cardHeight === next.cardHeight && now.linesAt480 === next.linesAt480
        ? now
        : next,
    );
  }, []);
  const island = islandShown(pill);
  const running = runningCount(tasks);
  const view = closedView({ island, pill: pill.shown, running });
  // The last island's card stays, so its text is still there while the island closes.
  const last = useRef<IslandCard | null>(null);
  const taskId = island ? pill.line?.taskId : undefined;
  const current = tasks.find((card) => card.taskId === taskId);
  if (current !== undefined) last.current = current;
  const width = islandWidth(size.linesAt480, frame.wide);
  const { shape } = frame;
  const silhouette = useMemo(
    () => silhouetteFor(view, shape, islandSilhouette(width, size.cardHeight)),
    [view, shape, width, size.cardHeight],
  );
  return {
    view,
    shape: silhouette,
    running,
    island: { card: last.current, width },
    onIslandSize,
  };
}
