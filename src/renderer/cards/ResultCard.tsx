import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import { Answer } from "./Answer";
import { CardShell, RetryButton, StatusLines } from "./CardFrame";
import { SourcesRow } from "./SourcesRow";

type ResultCardProps = { card: TaskCard; actions: CardActions };

// A done or incomplete result: the title, the answer and its sources; an incomplete one keeps its line and missing part.
export function ResultCard({ card, actions }: ResultCardProps) {
  const { answer } = card;
  return (
    <CardShell card={card}>
      <h3 className="type-title truncate">{card.words}</h3>
      <StatusLines card={card} />
      {answer !== null && (
        <div className="max-h-72 overflow-y-auto pr-1">
          <Answer markdown={answer.cardText} />
        </div>
      )}
      {answer !== null && answer.sources.length > 0 && (
        <SourcesRow
          taskId={card.taskId}
          sources={answer.sources}
          openSource={actions.openSource}
        />
      )}
      <RetryButton card={card} actions={actions} />
    </CardShell>
  );
}

export function ChatCard({ card }: { card: TaskCard }) {
  return (
    <article
      id={`card-${card.taskId}`}
      className="glass self-start rounded-[20px] px-4 py-2.5"
    >
      <p className="type-body">{card.reply}</p>
    </article>
  );
}
