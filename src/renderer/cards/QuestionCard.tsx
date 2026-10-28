import { useState, type FormEvent } from "react";
import type { ClarifyingQuestion, TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import {
  CardFooter,
  CardHeader,
  CardShell,
  pillButton,
  TalkerReply,
} from "./CardFrame";
import { Pill } from "./Pill";

type QuestionProps = {
  card: TaskCard;
  question: ClarifyingQuestion & { answered: boolean };
  actions: CardActions;
};

function Choices({ card, question, actions }: QuestionProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {question.choices.map((choice, index) => (
        <button
          key={index}
          type="button"
          disabled={question.answered}
          className={`${pillButton} flex items-center gap-2 text-left`}
          onClick={() =>
            actions.answerQuestion({
              taskId: card.taskId,
              questionId: question.questionId,
              reply: { kind: "choice", index },
            })
          }
        >
          <span>{choice}</span>
          {index === 0 && (
            <span className="text-[10px] uppercase tracking-wide text-amber-300">
              Recommended
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function SomethingElse({ card, question, actions }: QuestionProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const text = draft.trim();
  if (!open) {
    return (
      <button
        type="button"
        disabled={question.answered}
        className={`${pillButton} self-start`}
        onClick={() => setOpen(true)}
      >
        Something else
      </button>
    );
  }
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (text === "" || question.answered) return;
    actions.answerQuestion({
      taskId: card.taskId,
      questionId: question.questionId,
      reply: { kind: "text", text },
    });
  };
  return (
    <form className="flex gap-2" onSubmit={send}>
      <input
        aria-label="Your answer"
        value={draft}
        disabled={question.answered}
        onChange={(event) => setDraft(event.target.value)}
        className="min-w-0 flex-1 rounded-full bg-zinc-800 px-3 py-1 text-sm text-zinc-100 placeholder:text-zinc-400 disabled:opacity-50"
        placeholder="Something else…"
      />
      <button
        type="submit"
        disabled={text === "" || question.answered}
        className={pillButton}
      >
        Send
      </button>
    </form>
  );
}

function QuestionBody({ card, question, actions }: QuestionProps) {
  return (
    <CardShell>
      <CardHeader card={card} />
      <TalkerReply card={card} />
      {card.sayBack !== null && (
        <p className="text-sm text-zinc-300">{card.sayBack}</p>
      )}
      {card.line !== null && (
        <p className="text-sm text-amber-200">{card.line}</p>
      )}
      <p className="text-sm text-zinc-100">{question.text}</p>
      <Choices card={card} question={question} actions={actions} />
      <SomethingElse card={card} question={question} actions={actions} />
      {question.answered && (
        <p className="text-xs text-zinc-400">Answer sent</p>
      )}
      <CardFooter card={card} actions={actions} />
    </CardShell>
  );
}

type CardProps = { card: TaskCard; actions: CardActions };

export function QuestionCard({ card, actions }: CardProps) {
  if (card.question === null) return <Pill card={card} actions={actions} />;
  return (
    <QuestionBody card={card} question={card.question} actions={actions} />
  );
}
