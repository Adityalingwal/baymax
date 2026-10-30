import type { TaskCard as Card } from "../../shared/cards";
import type { CardActions } from "../actions";
import { cardForm } from "./forms";
import { ResultCard } from "./ResultCard";
import { RunningCard } from "./RunningCard";

type TaskCardProps = { card: Card; actions: CardActions };

export function TaskCard({ card, actions }: TaskCardProps) {
  return cardForm(card) === "open" ? (
    <ResultCard card={card} actions={actions} />
  ) : (
    <RunningCard card={card} actions={actions} />
  );
}
