import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import { CardHeader } from "./CardFrame";

type FoldedCardProps = { card: TaskCard; actions: CardActions };

export function FoldedCard({ card, actions }: FoldedCardProps) {
  return (
    <button
      type="button"
      className="w-full cursor-pointer rounded-2xl bg-[#1C1C1E] px-3 py-2 hover:bg-zinc-800"
      onClick={() =>
        actions.setCardFolded({ taskId: card.taskId, folded: false })
      }
    >
      <CardHeader card={card}>
        <span aria-hidden="true" className="text-sm text-zinc-300">
          ⌄
        </span>
      </CardHeader>
    </button>
  );
}
