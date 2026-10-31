import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { TaskCard as Card, TaskId } from "../../shared/cards";
import type { CardActions } from "../actions";
import { PillScroll } from "../PillScroll";
import { TaskCard } from "./TaskCard";

type TasksListProps = {
  cards: Card[];
  actions: CardActions;
  onOpenReport: (taskId: TaskId) => void;
  keptScroll: RefObject<number>; // survives the list going away, so Back returns to where it was
};

export function TasksList(props: TasksListProps) {
  const { cards, actions, onOpenReport, keptScroll } = props;
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current !== null) list.current.scrollTop = keptScroll.current;
  }, [keptScroll]);
  if (cards.length === 0) return null;
  return (
    <PillScroll
      ref={list}
      contentClassName="flex flex-col gap-3"
      onScroll={(event) => {
        keptScroll.current = event.currentTarget.scrollTop;
      }}
    >
      {cards.map((card) => (
        <TaskCard
          key={card.taskId}
          card={card}
          actions={actions}
          onOpenReport={onOpenReport}
        />
      ))}
    </PillScroll>
  );
}
