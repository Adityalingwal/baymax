import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import { Answer } from "./Answer";
import { CardFooter, CardHeader, CardShell, revealOnHover } from "./CardFrame";
import { sourcesCount } from "./forms";
import { SourcesRow } from "./SourcesRow";

type OpenCardProps = { card: TaskCard; actions: CardActions };

const iconButton = `cursor-pointer rounded-full px-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 ${revealOnHover}`;

function HeaderControls({ card, actions }: OpenCardProps) {
  return (
    <>
      <button
        type="button"
        aria-label="Fold card"
        className={iconButton}
        onClick={() =>
          actions.setCardFolded({ taskId: card.taskId, folded: true })
        }
      >
        ⌃
      </button>
      <button
        type="button"
        aria-label="Close card"
        className={iconButton}
        onClick={() => actions.closeCard({ taskId: card.taskId })}
      >
        ×
      </button>
    </>
  );
}

function missingText(card: TaskCard): string | null {
  if (card.missing === null) return null;
  return card.line === null ? card.missing : `Not checked: ${card.missing}`;
}

export function OpenCard({ card, actions }: OpenCardProps) {
  const missing = missingText(card);
  const { answer } = card;
  return (
    <CardShell>
      <CardHeader card={card}>
        <HeaderControls card={card} actions={actions} />
      </CardHeader>
      <p className="text-xs text-zinc-400">
        Read {sourcesCount(card.sourcesRead)}
      </p>
      {card.line !== null && (
        <p className="text-sm text-amber-200">{card.line}</p>
      )}
      {missing !== null && <p className="text-sm text-zinc-300">{missing}</p>}
      {answer !== null && (
        <div className="max-h-72 overflow-y-auto pr-1">
          <Answer
            taskId={card.taskId}
            markdown={answer.cardText}
            openSource={actions.openSource}
          />
        </div>
      )}
      {answer !== null && answer.sources.length > 0 && (
        <SourcesRow
          taskId={card.taskId}
          sources={answer.sources}
          openSource={actions.openSource}
        />
      )}
      <CardFooter card={card} actions={actions} />
    </CardShell>
  );
}
