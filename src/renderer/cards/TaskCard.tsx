import type { TaskCard as Card } from "../../shared/cards";
import type { CardActions } from "../actions";
import { FoldedCard } from "./FoldedCard";
import { cardForm } from "./forms";
import { OpenCard } from "./OpenCard";
import { Pill } from "./Pill";
import { QuestionCard } from "./QuestionCard";

type TaskCardProps = { card: Card; actions: CardActions };

export function TaskCard({ card, actions }: TaskCardProps) {
  switch (cardForm(card)) {
    case "question":
      // Keyed by question, so a new question starts with a closed, empty "Something else".
      return (
        <QuestionCard
          key={card.question?.questionId ?? ""}
          card={card}
          actions={actions}
        />
      );
    case "open":
      return <OpenCard card={card} actions={actions} />;
    case "folded":
      return <FoldedCard card={card} actions={actions} />;
    default:
      return <Pill card={card} actions={actions} />;
  }
}
