import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TaskCard } from "../../shared/cards";
import { cardTitle } from "../cards/forms";
import { islandLayout } from "./views";

export type IslandSize = { cardHeight: number; linesAt480: number };

type IslandProps = {
  card: Pick<TaskCard, "taskId" | "title" | "words" | "spokenLine"> | null;
  width: number; // the island's body width: 480, or the panel's width for a long line
  windowWidth: number;
  interactive: boolean;
  cardRef: RefObject<HTMLButtonElement | null>;
  onOpen: (taskId: string) => void;
  onSize: (size: IslandSize) => void;
};

// The spoken line's text width on a 480 pt island: minus the island's sides and the card's own padding.
const textWidthAt480 = islandLayout.width - 2 * islandLayout.side - 32;
const lineColor = { color: "rgb(255 255 255 / 72%)" };

// Observed, not measured once: the font may finish loading after the first layout and change the line count.
function useIslandSize(
  cardRef: IslandProps["cardRef"],
  onSize: IslandProps["onSize"],
) {
  const [card, setCard] = useState<HTMLButtonElement | null>(null);
  const [probe, setProbe] = useState<HTMLParagraphElement | null>(null);
  const report = useRef(onSize);
  report.current = onSize;
  const attachCard = useCallback(
    (element: HTMLButtonElement | null) => {
      cardRef.current = element;
      setCard(element);
    },
    [cardRef],
  );
  useEffect(() => {
    if (card === null || probe === null) return;
    const measure = () =>
      report.current({
        cardHeight: card.offsetHeight,
        linesAt480: Math.round(probe.offsetHeight / islandLayout.lineHeight),
      });
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [card, probe]);
  return { attachCard, setProbe };
}

// The answer island's card under the Speaking strip: the task's title and its spoken line. A click opens the result in the panel.
export function Island(props: IslandProps) {
  const { card, width, windowWidth, interactive, onOpen } = props;
  const { attachCard, setProbe } = useIslandSize(props.cardRef, props.onSize);
  const line = card?.spokenLine ?? "";
  const { strip, gap, side } = islandLayout;
  const open = () => {
    if (card !== null) onOpen(card.taskId);
  };
  return (
    <div
      className="panel-type absolute"
      style={{
        top: strip + gap,
        left: (windowWidth - width) / 2 + side,
        width: width - 2 * side,
      }}
      aria-hidden={!interactive}
      inert={!interactive}
    >
      <button
        ref={attachCard}
        type="button"
        className="glass flex w-full cursor-pointer flex-col gap-[5px] rounded-[20px] px-4 py-2.5 text-left"
        onClick={open}
      >
        <span className="w-full truncate text-[14px] leading-5 font-bold text-[#F5F5F7]">
          {card === null ? "" : cardTitle(card)}
        </span>
        <span className="text-[12.5px] leading-[19px]" style={lineColor}>
          {line}
        </span>
      </button>
      <p
        ref={setProbe}
        aria-hidden="true"
        className="invisible absolute top-0 left-0 text-[12.5px] leading-[19px]"
        style={{ width: textWidthAt480 }}
      >
        {line}
      </p>
    </div>
  );
}
