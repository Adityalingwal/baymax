import { useLayoutEffect, useRef } from "react";
import type { TaskId } from "../shared/cards";
import type { ChatRow } from "./panel-contents";
import { PillScroll } from "./PillScroll";

type OpenReport = (taskId: TaskId) => void;

function Message({
  row,
  onOpenReport,
}: {
  row: ChatRow;
  onOpenReport: OpenReport;
}) {
  const you = row.side === "left";
  const { reportOf } = row;
  return (
    <div
      className={`chat-message shrink-0 ${you ? "chat-you" : "chat-baymax"}`}
    >
      <div className="chat-label">{you ? "You" : "Baymax"}</div>
      <div>{row.text}</div>
      {reportOf !== null && (
        <button
          type="button"
          className="chat-open-report"
          onClick={() => onOpenReport(reportOf)}
        >
          Open report
        </button>
      )}
    </div>
  );
}

// The list follows the newest entry, which sits at the bottom.
export function ChatList({
  rows,
  onOpenReport,
}: {
  rows: ChatRow[];
  onOpenReport: OpenReport;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current !== null)
      list.current.scrollTop = list.current.scrollHeight;
  }, [rows.length]);
  if (rows.length === 0) return null;
  return (
    <PillScroll ref={list} contentClassName="flex flex-col gap-[18px]">
      {rows.map((row) => (
        <Message key={row.id} row={row} onOpenReport={onOpenReport} />
      ))}
    </PillScroll>
  );
}
