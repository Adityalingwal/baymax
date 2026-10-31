import { useLayoutEffect, useRef } from "react";
import type { ChatRow } from "./panel-contents";

function Bubble({ row }: { row: ChatRow }) {
  const look = row.side === "left" ? "chat-you" : "chat-baymax glass";
  return <div className={`chat-bubble ${look}`}>{row.text}</div>;
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
      className="flex min-h-0 shrink flex-col gap-2 overflow-y-auto"
    >
      {rows.map((row) => (
        <div
          key={row.id}
          className={`flex shrink-0 items-end gap-2 ${row.side === "right" ? "justify-end" : ""}`}
        >
          <Bubble row={row} />
        </div>
      ))}
    </section>
  );
}
