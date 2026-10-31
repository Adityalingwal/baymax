import { useLayoutEffect, useRef } from "react";
import type { ChatRow } from "./panel-contents";

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
  const list = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (list.current !== null)
      list.current.scrollTop = list.current.scrollHeight;
  }, [rows.length]);
  if (rows.length === 0) return null;
  return (
    <section
      ref={list}
      className="flex min-h-0 shrink flex-col gap-[18px] overflow-y-auto"
    >
      {rows.map((row) => (
        <Message key={row.id} row={row} />
      ))}
    </section>
  );
}
