import type { SetupState } from "../shared/ipc";

export type SetupIcon = "pending" | "waiting" | "done";

export type SetupAction =
  "open-accessibility" | "ask-microphone" | "open-microphone";

export type SetupRow = {
  name: string;
  icon: SetupIcon;
  hint: string | null;
  button: { label: string; action: SetupAction } | null;
  dimmed: boolean;
};

// What was clicked and has no answer yet. The microphone keeps the status it was clicked in, so a denial in macOS's popup ends the wait.
export type SetupClicks = {
  accessibility: boolean;
  microphone: SetupState["microphone"] | null;
};

export const noClicks: SetupClicks = { accessibility: false, microphone: null };

export function setupReady(state: SetupState): boolean {
  return state.accessibility === "granted" && state.microphone === "granted";
}

// With no Deepgram key a hold cannot work, so the checklist and its notice stay until the app is run again.
export function setupCanEnd(state: SetupState, keyMissing: boolean): boolean {
  return state.needed && setupReady(state) && !keyMissing;
}

export type ChecklistStage = "setup" | "ended" | "closed" | "gone";

// After setup ends the checklist stays through the panel's close, so the close never flashes the normal contents; the next open is the normal panel for good.
export function nextChecklistStage(
  stage: ChecklistStage,
  ended: boolean,
  open: boolean,
): ChecklistStage {
  if (stage === "gone" || !ended) return stage;
  if (stage === "closed") return open ? "gone" : "closed";
  return open ? "ended" : "closed";
}

function accessibilityRow(state: SetupState, clicks: SetupClicks): SetupRow {
  const row = { name: "Accessibility", dimmed: false };
  switch (state.accessibility) {
    case "granted":
      return { ...row, icon: "done", hint: null, button: null };
    case "failed":
      return {
        ...row,
        icon: "pending",
        hint: "Quit and run npm start again",
        button: null,
      };
    case "missing":
      return clicks.accessibility
        ? { ...row, icon: "waiting", hint: "Switch on Electron", button: null }
        : {
            ...row,
            icon: "pending",
            hint: "Switch on Electron",
            button: { label: "Open settings", action: "open-accessibility" },
          };
  }
}

function microphoneRow(state: SetupState, clicks: SetupClicks): SetupRow {
  const { microphone } = state;
  const row = { name: "Microphone", dimmed: false };
  if (microphone === "granted") {
    return { ...row, icon: "done", hint: null, button: null };
  }
  const hint =
    microphone === "ask"
      ? "Choose Allow"
      : "Switch on Electron in Microphone settings";
  if (state.accessibility !== "granted") {
    const shown = microphone === "ask" ? null : hint;
    return { ...row, icon: "pending", hint: shown, button: null, dimmed: true };
  }
  if (clicks.microphone === microphone) {
    return { ...row, icon: "waiting", hint, button: null };
  }
  const button =
    microphone === "ask"
      ? { label: "Allow", action: "ask-microphone" as const }
      : { label: "Open settings", action: "open-microphone" as const };
  return { ...row, icon: "pending", hint, button };
}

// What each row of the checklist shows, in order.
export function setupRows(
  state: SetupState,
  clicks: SetupClicks,
): readonly [SetupRow, SetupRow] {
  return [accessibilityRow(state, clicks), microphoneRow(state, clicks)];
}
