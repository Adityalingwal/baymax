import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import { ReportButton } from "../cards/Chevron";
import { cardTitle, shownReport } from "../cards/forms";
import { ReportBody } from "../cards/ReportPage";
import { PillScroll } from "../PillScroll";
import { islandCardMaxHeight, islandLayout } from "./views";

export type IslandSize = { cardHeight: number; linesAt480: number };

type IslandProps = {
  card: TaskCard | null;
  width: number; // the island's body width: 480, or its wide size for a long line or an open report
  windowWidth: number;
  windowHeight: number;
  interactive: boolean;
  reportOpen: boolean;
  cardRef: RefObject<HTMLDivElement | null>;
  onOpen: (taskId: string) => void;
  onToggleReport: () => void;
  openSource: CardActions["openSource"];
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
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [probe, setProbe] = useState<HTMLParagraphElement | null>(null);
  const report = useRef(onSize);
  report.current = onSize;
  const attachCard = useCallback(
    (element: HTMLDivElement | null) => {
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

type HeadingProps = Pick<IslandProps, "reportOpen" | "onToggleReport"> & {
  title: string;
  hasReport: boolean;
};

// The button stays in place, and with the title it stays outside the report's scroll.
function Heading(props: HeadingProps) {
  const { reportOpen } = props;
  return (
    <div className="flex shrink-0 items-start gap-3">
      <span className="min-w-0 flex-1 truncate text-[14px] leading-5 font-bold text-[#F5F5F7]">
        {props.title}
      </span>
      {props.hasReport && (
        <ReportButton
          direction={reportOpen ? "up" : "down"}
          label={reportOpen ? "Fold the report" : "Open the full report"}
          expanded={reportOpen}
          onClick={props.onToggleReport}
        />
      )}
    </div>
  );
}

// A click elsewhere on the card opens the panel on the Tasks tab; with the report open the card is for reading, so it opens nothing.
function CardContents(props: IslandProps) {
  const { card, reportOpen, onOpen } = props;
  const report = card === null ? null : shownReport(card);
  return (
    <>
      {card !== null && !reportOpen && (
        <button
          type="button"
          aria-label="Open in the Tasks tab"
          className="absolute inset-0 cursor-pointer rounded-[20px]"
          onClick={() => onOpen(card.taskId)}
        />
      )}
      <Heading
        title={card === null ? "" : cardTitle(card)}
        hasReport={report !== null}
        reportOpen={reportOpen}
        onToggleReport={props.onToggleReport}
      />
      <span className="shrink-0 text-[12.5px] leading-[19px]" style={lineColor}>
        {card?.spokenLine ?? ""}
      </span>
      {reportOpen && card !== null && report !== null && (
        <PillScroll
          className="mt-[5px]"
          contentClassName="flex flex-col gap-2.5"
          pillRight={-12}
        >
          <ReportBody
            card={card}
            report={report}
            openSource={props.openSource}
          />
        </PillScroll>
      )}
    </>
  );
}

// The answer island's card under the Speaking strip: the task's title and its spoken line, and its report when opened here.
export function Island(props: IslandProps) {
  const { width, windowWidth, interactive, reportOpen } = props;
  const { attachCard, setProbe } = useIslandSize(props.cardRef, props.onSize);
  const { strip, gap, side } = islandLayout;
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
      <div
        ref={attachCard}
        className="glass relative flex w-full flex-col gap-[5px] rounded-[20px] px-4 py-2.5 text-left"
        style={{
          maxHeight: reportOpen
            ? islandCardMaxHeight(props.windowHeight)
            : undefined,
        }}
      >
        <CardContents {...props} />
      </div>
      <p
        ref={setProbe}
        aria-hidden="true"
        className="invisible absolute top-0 left-0 text-[12.5px] leading-[19px]"
        style={{ width: textWidthAt480 }}
      >
        {props.card?.spokenLine ?? ""}
      </p>
    </div>
  );
}
