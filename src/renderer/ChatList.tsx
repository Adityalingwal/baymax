import { useLayoutEffect, useRef } from "react";
import type { ChatRow } from "./panel-contents";
import { PillScroll } from "./PillScroll";

function Message({ row }: { row: ChatRow }) {
  const you = row.side === "left";
  return (
    <div
      className={`chat-message shrink-0 ${you ? "chat-you" : "chat-baymax"}`}
    >
      <div className="chat-label">{you ? "You" : "Baymax"}</div>
      <div>{row.text}</div>
    </div>
  );
}

// The list follows the newest entry, which sits at the bottom.
export function ChatList({ rows }: { rows: ChatRow[] }) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current !== null)
      list.current.scrollTop = list.current.scrollHeight;
  }, [rows.length]);
  if (rows.length === 0) return null;
  return (
    <PillScroll ref={list} contentClassName="flex flex-col gap-[18px]">
      {rows.map((row) => (
        <Message key={row.id} row={row} />
      ))}
    </PillScroll>
  );
}
