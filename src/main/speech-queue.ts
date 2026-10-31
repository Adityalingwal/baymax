import type { LineId } from "../shared/ipc";
import type { TaskId } from "../shared/cards";
import type { LineText, StreamJob } from "./speech-stream";
import type { SaidKind } from "./tasks/state";

// key: the generation (release or typed question) of a talker reply, else null.
export type Line = {
  taskId: TaskId | null;
  kind: SaidKind;
  key: string | null;
  feed: LineText;
  silent?: boolean; // a result with no audio to play: it still gets its turn and its island
};

// A distinct object per synthesis, so a settled job can tell whether it still owns the slot.
export type Job = { line: Line; abort: AbortController };

// The line that owns playback until the renderer reports its end; started tells whether its audio began.
export type Playing = {
  lineId: LineId;
  line: Line;
  cancelDeadline: () => void;
  stream: StreamJob | null;
  started: boolean; // its first audio reached the renderer
};

export type SpeechState = {
  pending: Line[];
  synthesizing: Job | null;
  playing: Playing | null;
  island: LineId | null; // the result line whose island may still show; a later result line waits for its closing report
  held: boolean;
  turnPending: boolean;
  cancelQuiet: (() => void) | null; // running while the quiet a result waits for has not lasted yet
  muted: boolean;
  cancelled: Set<TaskId>;
  voiceAvailable: boolean;
};

export function createSpeechState(): SpeechState {
  return {
    pending: [],
    synthesizing: null,
    playing: null,
    island: null,
    held: false,
    turnPending: false,
    cancelQuiet: null,
    muted: false,
    cancelled: new Set(),
    voiceAvailable: true,
  };
}

// Other lines go ahead of a result line, which waits for the island to close and for quiet.
export function nextLine(state: SpeechState): Line | undefined {
  const { pending, island, turnPending, cancelQuiet } = state;
  const other = pending.find((line) => line.kind !== "answer");
  if (other !== undefined) return other;
  return island === null && !turnPending && cancelQuiet === null
    ? pending[0]
    : undefined;
}

export function takeLine(state: SpeechState, line: Line): void {
  state.pending = state.pending.filter((other) => other !== line);
}
