import type { ReactNode } from "react";
import type { TaskCard, TaskState } from "../../shared/cards";
import type { CardActions } from "../actions";
import { canCancel, stateLabel } from "./forms";

// The state dot colours, shared with the notch dot.
const dotColors: Record<TaskState, string> = {
  thinking: "bg-zinc-500",
  clarifying: "bg-amber-400",
  queued: "bg-zinc-500",
  running: "bg-blue-500",
  cancelling: "bg-zinc-500",
  done: "bg-green-500",
  incomplete: "bg-amber-400",
  cancelled: "bg-zinc-500",
};

// Opacity only, so Tab still reaches the control and focus-within shows it.
export const revealOnHover =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100";

export const pillButton =
  "cursor-pointer rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-100 hover:bg-zinc-700 disabled:cursor-default disabled:opacity-50";

export function CardShell({ children }: { children: ReactNode }) {
  return (
    <article className="group flex flex-col gap-1.5 rounded-2xl bg-[#1C1C1E] p-3">
      {children}
    </article>
  );
}

type HeaderProps = { card: TaskCard; children?: ReactNode };

// Spans only, so the folded card can put this row inside its button.
export function CardHeader({ card, children }: HeaderProps) {
  return (
    <span className="flex w-full items-center gap-2">
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${dotColors[card.state]}`}
      />
      <span className="shrink-0 text-xs font-medium text-zinc-400">
        {stateLabel(card.state)}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-sm text-zinc-100">
        {card.words}
      </span>
      {children}
    </span>
  );
}

type ControlProps = { card: TaskCard; actions: CardActions };

function CancelButton({ card, actions }: ControlProps) {
  if (!canCancel(card.state)) return null;
  return (
    <button
      type="button"
      aria-label="Cancel task"
      className={`${pillButton} ${revealOnHover}`}
      onClick={() => actions.cancelTask({ taskId: card.taskId })}
    >
      Cancel
    </button>
  );
}

function RetryButton({ card, actions }: ControlProps) {
  if (!card.canRetry) return null;
  return (
    <button
      type="button"
      className={pillButton}
      onClick={() => actions.retryTask({ taskId: card.taskId })}
    >
      Retry
    </button>
  );
}

export function CardFooter({ card, actions }: ControlProps) {
  if (!card.canRetry && !canCancel(card.state)) return null;
  return (
    <div className="flex justify-end gap-2">
      <RetryButton card={card} actions={actions} />
      <CancelButton card={card} actions={actions} />
    </div>
  );
}

// The talker's spoken reply, unless it is already the card's answer (a chat card).
export function TalkerReply({ card }: { card: TaskCard }) {
  const { reply } = card;
  if (reply === null || reply === card.answer?.cardText) return null;
  return <p className="text-sm text-zinc-200">{reply}</p>;
}
