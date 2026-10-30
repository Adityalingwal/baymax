import type { TaskCard as Card } from "../../shared/cards";
import type { CardActions } from "../actions";
import { CardShell, LabelLine, RetryButton, StopButton } from "./CardFrame";
import { cardContents, cardTitle } from "./forms";
import { SourcesRow } from "./SourcesRow";

type TaskCardProps = { card: Card; actions: CardActions };

// One card of the Tasks list; forms.ts decides what each kind shows.
export function TaskCard({ card, actions }: TaskCardProps) {
  const shows = cardContents(card);
  return (
    <CardShell card={card}>
      {shows.label !== null && (
        <LabelLine pulse={shows.pulse}>{shows.label}</LabelLine>
      )}
      <h3 className={`type-title truncate ${shows.stop ? "pr-9" : ""}`}>
        {cardTitle(card)}
      </h3>
      {shows.live !== null && (
        <p className="type-body shimmer truncate">{shows.live}</p>
      )}
      {shows.line !== null && <p className="type-body">{shows.line}</p>}
      {shows.sources.length > 0 && (
        <SourcesRow
          taskId={card.taskId}
          sources={shows.sources}
          openSource={actions.openSource}
        />
      )}
      {shows.retry && <RetryButton card={card} actions={actions} />}
      {shows.stop && <StopButton card={card} actions={actions} />}
    </CardShell>
  );
}
