import type { ClarifyingQuestion, TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import {
  CardShell,
  LabelLine,
  RetryButton,
  StatusLines,
  StopButton,
} from "./CardFrame";
import { RunningCard } from "./RunningCard";

type QuestionProps = {
  card: TaskCard;
  question: ClarifyingQuestion;
  actions: CardActions;
};

// Question only: the answer comes by voice or through the panel's field, which main binds to this question.
function QuestionBody({ card, question, actions }: QuestionProps) {
  return (
    <CardShell card={card}>
      <LabelLine>Needs you · {card.words}</LabelLine>
      <p className="type-title pr-9">{question.text}</p>
      <p className="type-hint">Say it or type below</p>
      <StatusLines card={card} />
      <RetryButton card={card} actions={actions} />
      <StopButton card={card} actions={actions} />
    </CardShell>
  );
}

type CardProps = { card: TaskCard; actions: CardActions };

export function ClarifyingCard({ card, actions }: CardProps) {
  if (card.question === null) {
    return <RunningCard card={card} actions={actions} />;
  }
  return (
    <QuestionBody card={card} question={card.question} actions={actions} />
  );
}
