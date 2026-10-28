import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import { CardFooter, CardHeader, CardShell, TalkerReply } from "./CardFrame";
import { sourcesCount } from "./forms";

function progressText(card: TaskCard): string | null {
  const count = card.sourcesRead > 0 ? sourcesCount(card.sourcesRead) : null;
  if (card.step === null) return count;
  return count === null ? card.step : `${card.step} · ${count}`;
}

type PillProps = { card: TaskCard; actions: CardActions };

export function Pill({ card, actions }: PillProps) {
  const said = card.line ?? card.sayBack;
  const progress = progressText(card);
  return (
    <CardShell>
      <CardHeader card={card} />
      <TalkerReply card={card} />
      {said !== null && <p className="text-sm text-zinc-300">{said}</p>}
      {progress !== null && (
        <p className="truncate text-xs text-zinc-400">{progress}</p>
      )}
      <CardFooter card={card} actions={actions} />
    </CardShell>
  );
}
