import type { TaskId } from "../../shared/cards";
import type { EngineEvent } from "../../shared/engine";
import { messageOf } from "./dev-log";
import type { DevLog } from "./dev-log";
import type { PortSide } from "./port";

type Hold = {
  controller: AbortController;
  settled: Promise<void>;
  cancelling: boolean; // a cancelled event is already promised for this hold
};

export type Holds = {
  log: DevLog;
  side: PortSide;
  held: Map<TaskId, Hold>;
};

// The work of one held task: it returns its one terminal event, or null when it has nothing to say.
type HeldWork = {
  start: (signal: AbortSignal) => Promise<EngineEvent | null>;
  onThrow: EngineEvent;
};

export function createHolds(log: DevLog, side: PortSide): Holds {
  return { log, side, held: new Map() };
}

// Catches everything, so settled never rejects; the hold is the only sender of its task's terminal event.
async function settleHold(
  holds: Holds,
  taskId: TaskId,
  hold: Hold,
  work: HeldWork,
): Promise<void> {
  let event: EngineEvent | null;
  try {
    event = await work.start(hold.controller.signal);
  } catch (error) {
    holds.log({ event: "commandError", taskId, message: messageOf(error) });
    event = work.onThrow;
  }
  if (holds.held.get(taskId) === hold) holds.held.delete(taskId);
  if (event !== null && !hold.controller.signal.aborted) holds.side.emit(event);
}

export function startHold(holds: Holds, taskId: TaskId, work: HeldWork): void {
  if (holds.held.has(taskId)) {
    holds.log({ event: "duplicateTask", taskId });
    return;
  }
  const hold: Hold = {
    controller: new AbortController(),
    settled: Promise.resolve(),
    cancelling: false,
  };
  holds.held.set(taskId, hold);
  hold.settled = settleHold(holds, taskId, hold, work);
}

// One cancelled per held task, sent only after its work has settled.
export function cancelHold(holds: Holds, taskId: TaskId): void {
  const cancelled: EngineEvent = { type: "cancelled", taskId, findings: null };
  const hold = holds.held.get(taskId);
  if (hold === undefined) {
    holds.side.emitLater(cancelled);
    return;
  }
  if (hold.cancelling) return;
  hold.cancelling = true;
  hold.controller.abort();
  hold.settled.then(
    () => holds.side.emit(cancelled),
    () => undefined,
  );
}

export function closeHolds(holds: Holds): void {
  for (const hold of holds.held.values()) hold.controller.abort();
  holds.held.clear();
}
