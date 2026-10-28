import type { UtteranceId } from "../shared/cards";
import type { WaitingQuestion } from "./tasks/talk";
import type { MainState } from "./tasks/state";

export type VoiceState = Pick<
  MainState,
  "ask" | "waitingQuestion" | "setMuted" | "setVoiceAvailable" | "showNotice"
>;

// The waiting question at key-down, the hold's place in time and its release, kept until its words are delivered.
type Admitted = {
  waiting: WaitingQuestion | null;
  order: number;
  releasedAt: number | null;
};

export type VoiceModel = {
  state: VoiceState | null;
  admitted: Map<UtteranceId, Admitted>;
  nextOrder: number;
  current: UtteranceId | null;
  sttUp: boolean;
  sttOrder: number;
  ttsUp: boolean;
  told: boolean;
  releasedAt: number | null;
  held: boolean;
  stopped: boolean;
};

const admittedLimit = 16;

export function createModel(): VoiceModel {
  return {
    state: null,
    admitted: new Map(),
    nextOrder: 1,
    current: null,
    sttUp: true,
    sttOrder: 0,
    ttsUp: true,
    told: true,
    releasedAt: null,
    held: false,
    stopped: false,
  };
}

export function admit(model: VoiceModel, utteranceId: UtteranceId): void {
  const waiting = model.state?.waitingQuestion() ?? null;
  const order = model.nextOrder;
  model.admitted.set(utteranceId, { waiting, order, releasedAt: null });
  model.nextOrder += 1;
  if (model.admitted.size <= admittedLimit) return;
  const oldest = model.admitted.keys().next();
  if (oldest.done !== true) model.admitted.delete(oldest.value);
}

export function tellHealth(model: VoiceModel): void {
  const up = model.sttUp && model.ttsUp;
  const state = model.state;
  if (state === null || up === model.told) return;
  model.told = up;
  state.setVoiceAvailable(up);
}

// An older utterance's result arriving late never overrides a newer one's.
export function setStt(
  model: VoiceModel,
  log: (message: string) => void,
  up: boolean,
  order: number,
): void {
  if (order <= model.sttOrder) {
    log("an older transcript result left STT health as it was");
    return;
  }
  model.sttOrder = order;
  model.sttUp = up;
  tellHealth(model);
}
