import type { ReactNode } from "react";
import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import { canCancel } from "./forms";

// One glass card; the id lets the panel scroll a result into view.
export function CardShell({
  card,
  children,
}: {
  card: TaskCard;
  children: ReactNode;
}) {
  return (
    <article
      id={`card-${card.taskId}`}
      className="glass relative flex flex-col gap-1.5 rounded-[20px] px-4 py-3.5"
    >
      {children}
    </article>
  );
}

type LabelProps = { pulse?: boolean; children: ReactNode };

export function LabelLine({ pulse = false, children }: LabelProps) {
  return (
    <p className="type-label flex min-w-0 items-center gap-2 pr-9">
      {pulse && (
        <span
          aria-hidden="true"
          className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-white"
        />
      )}
      <span className="truncate">{children}</span>
    </p>
  );
}

type ControlProps = { card: TaskCard; actions: CardActions };

export function StopButton({ card, actions }: ControlProps) {
  if (!canCancel(card.state)) return null;
  return (
    <button
      type="button"
      aria-label="Stop task"
      className="glass absolute top-3 right-3 grid h-7 w-7 cursor-pointer place-items-center rounded-full"
      onClick={() => actions.cancelTask({ taskId: card.taskId })}
    >
      <span aria-hidden="true" className="h-2 w-2 rounded-[2px] bg-white" />
    </button>
  );
}

export function RetryButton({ card, actions }: ControlProps) {
  if (!card.canRetry) return null;
  return (
    <button
      type="button"
      className="action action-primary self-start"
      onClick={() => actions.retryTask({ taskId: card.taskId })}
    >
      Retry
    </button>
  );
}

// The fixed status or failure line main wrote, and the incomplete card's missing part.
export function StatusLines({ card }: { card: TaskCard }) {
  const missing =
    card.missing === null
      ? null
      : card.line === null
        ? card.missing
        : `Not checked: ${card.missing}`;
  return (
    <>
      {card.line !== null && <p className="type-body">{card.line}</p>}
      {missing !== null && <p className="type-body">{missing}</p>}
    </>
  );
}
