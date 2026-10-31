import type { SetupState } from "../shared/ipc";

const recheckMs = 1000;

export type SetupDeps = {
  isMac: boolean;
  isTrusted: () => boolean;
  microphoneStatus: () => string; // Electron's media access status
  startHoldKey: () => void;
  publish: (state: SetupState) => void;
  setTimer: (ms: number, fire: () => void) => () => void;
  log: (message: string, error?: unknown) => void;
};

export type Setup = {
  current: () => SetupState;
  recheck: () => void;
  stop: () => void;
};

type Run = {
  deps: SetupDeps;
  state: SetupState;
  holdKeyTried: boolean;
  holdKeyFailed: boolean;
  cancelTimer: (() => void) | null;
  stopped: boolean;
};

function microphoneFrom(status: string): SetupState["microphone"] {
  if (status === "granted") return "granted";
  return status === "denied" || status === "restricted" ? "denied" : "ask";
}

// Tried once: a failed hook start needs a fresh process, so the row tells the person to run the app again.
function startHoldKeyOnce(run: Run, afterGrant: boolean): void {
  if (run.holdKeyTried) return;
  run.holdKeyTried = true;
  try {
    run.deps.startHoldKey();
    if (afterGrant) run.deps.log("[Hotkey] started after Accessibility grant");
  } catch (error) {
    run.holdKeyFailed = true;
    run.deps.log("[Hotkey] Failed to start:", error);
  }
}

function accessibilityFrom(
  run: Run,
  trusted: boolean,
): SetupState["accessibility"] {
  if (run.holdKeyFailed) return "failed";
  return trusted ? "granted" : "missing";
}

function schedule(run: Run): void {
  run.cancelTimer?.();
  run.cancelTimer = null;
  const { accessibility, microphone } = run.state;
  if (run.stopped) return;
  if (accessibility !== "missing" && microphone === "granted") return;
  run.cancelTimer = run.deps.setTimer(recheckMs, () => recheck(run));
}

function recheck(run: Run): void {
  if (run.stopped) return;
  const { deps, state } = run;
  const trusted = deps.isTrusted();
  if (trusted) startHoldKeyOnce(run, true);
  const accessibility = accessibilityFrom(run, trusted);
  const microphone = microphoneFrom(deps.microphoneStatus());
  if (
    accessibility !== state.accessibility ||
    microphone !== state.microphone
  ) {
    run.state = { needed: state.needed, accessibility, microphone };
    deps.publish(run.state);
  }
  schedule(run);
}

function initialState(run: Run): SetupState {
  const { deps } = run;
  if (!deps.isMac) {
    startHoldKeyOnce(run, false);
    return {
      needed: false,
      accessibility: accessibilityFrom(run, true),
      microphone: "granted",
    };
  }
  const trusted = deps.isTrusted();
  const microphone = microphoneFrom(deps.microphoneStatus());
  if (trusted) startHoldKeyOnce(run, false);
  else deps.log("[Hotkey] Waiting for Accessibility permission");
  return {
    needed: !trusted || microphone !== "granted",
    accessibility: accessibilityFrom(run, trusted),
    microphone,
  };
}

// The checklist's facts: asked at launch, rechecked each second while anything is missing, and the hold-key started on the Accessibility grant.
export function startSetup(deps: SetupDeps): Setup {
  const run: Run = {
    deps,
    state: { needed: false, accessibility: "missing", microphone: "ask" },
    holdKeyTried: false,
    holdKeyFailed: false,
    cancelTimer: null,
    stopped: false,
  };
  run.state = initialState(run);
  schedule(run);
  return {
    current: () => run.state,
    recheck: () => recheck(run),
    stop: () => {
      run.stopped = true;
      schedule(run);
    },
  };
}
