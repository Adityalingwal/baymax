import type { TaskId } from "../../shared/cards";
import type { Change, TaskRecord } from "./record";
import { dropped, endChat, endIncomplete } from "./record";
import type { TalkerReply } from "./talk";

function endWith(change: Change, record: TaskRecord, reply: TalkerReply) {
  if (reply.kind === "said") return endChat(change, record, reply.text);
  // Nothing was said, so the card ends like a failed step, with its fixed line.
  const cause = reply.failure;
  endIncomplete(change, record, { kind: "error", cause, findings: null });
}

// The talker's line was the whole answer: the thinking card becomes a done card once that line is known.
export function chat(
  change: Change,
  record: TaskRecord,
  sayBack: string,
): boolean {
  record.card.sayBack = sayBack;
  record.chat = true;
  if (record.reply !== null) endWith(change, record, record.reply);
  return true;
}

export function receiveReply(
  change: Change,
  taskId: TaskId,
  reply: TalkerReply,
): boolean {
  const record = change.model.records.get(taskId);
  if (record === undefined || record.reply !== null) {
    return dropped(change, `talker reply for ${taskId}`);
  }
  record.reply = reply;
  // Kept for a chat route that may still come; nothing shown changes yet.
  if (!record.chat || record.card.state !== "thinking") return false;
  endWith(change, record, reply);
  return true;
}
