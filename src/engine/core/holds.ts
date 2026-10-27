import type { Findings, TaskId } from "../../shared/cards";
import type { EngineEvent } from "../../shared/engine";
import { messageOf } from "./dev-log";
import type { DevLog } from "./dev-log";
import type { PortSide } from "./port";

type Hold = {
  controller: AbortController;
  cancelling: boolean; // a cancelled event is already promised for this hold
  finished: boolean; // the work has ended; its terminal event is sent or dropped
};

export type Holds = {
  log: DevLog;
  side: PortSide;
  held: Map<TaskId, Hold>;
};

// A run's view of what it has found so far; the run sets current when it starts.
export type FoundSoFar = { current: () => Findings | null };

// The work of one held task: it returns its one terminal event, or null when it has nothing to say.
type HeldWork = {
  start: (signal: AbortSignal) => Promise<EngineEvent | null>;
  found: () => Findings | null; // what the work has found so far
  onThrow: (found: Findings | null) => EngineEvent;
};

export function createHolds(log: DevLog, side: PortSide): Holds {
  return { log, side, held: new Map() };
}

function foundBy(work: HeldWork): Findings | null {
  try {
    return work.found();
  } catch {
    return null;
  }
}

// Catches everything, so it never rejects; the hold is the only sender of its task's terminal event.
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
    event = work.onThrow(foundBy(work));
  }
  hold.finished = true;
  // Sent while the hold is still held, so a cancel from a listener of this event finds it finished.
  if (hold.cancelling) {
    holds.side.emit({ type: "cancelled", taskId, findings: foundBy(work) });
  } else if (event !== null && !hold.controller.signal.aborted) {
    holds.side.emit(event);
  }
  if (holds.held.get(taskId) === hold) holds.held.delete(taskId);
}

export function startHold(holds: Holds, taskId: TaskId, work: HeldWork): void {
  // A finished hold may still be emitting its event, whose listener may send this task's next command.
  if (holds.held.get(taskId)?.finished === false) {
    holds.log({ event: "duplicateTask", taskId });
    return;
  }
  const hold: Hold = {
    controller: new AbortController(),
    cancelling: false,
    finished: false,
  };
  holds.held.set(taskId, hold);
  settleHold(holds, taskId, hold, work).catch((error: unknown) =>
    holds.log({ event: "commandError", taskId, message: messageOf(error) }),
  );
}

// One cancelled per held task: the hold sends it once its work has settled, with what it had found.
export function cancelHold(holds: Holds, taskId: TaskId): void {
  const hold = holds.held.get(taskId);
  if (hold === undefined) {
    holds.side.emitLater({ type: "cancelled", taskId, findings: null });
    return;
  }
  if (hold.cancelling) return;
  if (hold.finished) {
    holds.log({ event: "cancelAfterEnd", taskId });
    return;
  }
  hold.cancelling = true;
  hold.controller.abort();
}

export function closeHolds(holds: Holds): void {
  for (const hold of holds.held.values()) hold.controller.abort();
  holds.held.clear();
}
