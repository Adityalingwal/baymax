import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import {
  CardShell,
  LabelLine,
  RetryButton,
  StatusLines,
  StopButton,
} from "./CardFrame";
import { isPending, stateLabel } from "./forms";

type RunningCardProps = { card: TaskCard; actions: CardActions };

// Thinking, queued, running, cancelling or cancelled: the label, the title, and one live line while work is really pending.
export function RunningCard({ card, actions }: RunningCardProps) {
  const pending = isPending(card);
  return (
    <CardShell card={card}>
      <LabelLine pulse={card.state === "running"}>
        {stateLabel(card.state)}
      </LabelLine>
      <h3 className="type-title truncate pr-9">{card.words}</h3>
      {pending && card.step !== null && (
        <p className="type-body shimmer truncate">{card.step}</p>
      )}
      <StatusLines card={card} />
      {/* A request outside research ends cancelled, with the front call's own line saying why. */}
      {card.state === "cancelled" && card.reply !== null && (
        <p className="type-body">{card.reply}</p>
      )}
      <RetryButton card={card} actions={actions} />
      <StopButton card={card} actions={actions} />
    </CardShell>
  );
}
