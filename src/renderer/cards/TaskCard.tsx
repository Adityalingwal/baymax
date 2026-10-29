import type { TaskCard as Card } from "../../shared/cards";
import type { CardActions } from "../actions";
import { ClarifyingCard } from "./ClarifyingCard";
import { cardForm, isChatReply } from "./forms";
import { ChatCard, ResultCard } from "./ResultCard";
import { RunningCard } from "./RunningCard";

type TaskCardProps = { card: Card; actions: CardActions };

export function TaskCard({ card, actions }: TaskCardProps) {
  if (isChatReply(card)) return <ChatCard card={card} />;
  switch (cardForm(card)) {
    case "question":
      return <ClarifyingCard card={card} actions={actions} />;
    case "open":
      return <ResultCard card={card} actions={actions} />;
    default:
      return <RunningCard card={card} actions={actions} />;
  }
}
