import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SetupState } from "../shared/ipc";
import { noClicks, setupReady, setupRows } from "./setup-steps";
import type { SetupAction, SetupIcon, SetupRow } from "./setup-steps";
import { CloseControl } from "./TopBar";

const on = (shows: boolean) => (shows ? "setup-on" : "");

// The last value shown, so what is leaving keeps its text while it fades.
function useLastShown(value: string | null): string {
  const last = useRef("");
  if (value !== null) last.current = value;
  return last.current;
}

function RowIcon({ icon }: { icon: SetupIcon }) {
  return (
    <span className="setup-icon" aria-hidden="true">
      <svg className={on(icon === "pending")} viewBox="0 0 16 16">
        <circle
          cx={8}
          cy={8}
          r={7.25}
          fill="none"
          stroke="rgb(255 255 255 / 30%)"
          strokeWidth={1.5}
        />
      </svg>
      <svg className={on(icon === "waiting")} viewBox="0 0 11 11">
        <circle
          cx={5.5}
          cy={5.5}
          r={4.7}
          fill="none"
          stroke="rgb(255 255 255 / 22%)"
          strokeWidth={1.6}
          vectorEffect="non-scaling-stroke"
        />
        {/* Only while it shows: this window is always on screen, so a hidden spin would waste power. */}
        <path
          className={icon === "waiting" ? "ring-spin" : ""}
          d="M5.5,0.8 A4.7,4.7 0 0 1 10.2,5.5"
          fill="none"
          stroke="#fff"
          strokeWidth={1.6}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <svg className={on(icon === "done")} viewBox="0 0 16 16">
        <path
          d="M3 8.5l3.2 3.2L13 4.8"
          fill="none"
          stroke="#fff"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

type FoldProps = { shows: boolean; className: string; children: ReactNode };

// Its height and opacity animate together.
function Fold({ shows, className, children }: FoldProps) {
  return (
    <div className={`${className} ${on(shows)}`} aria-hidden={!shows}>
      <div>{children}</div>
    </div>
  );
}

type RowProps = { row: SetupRow; onAction: (action: SetupAction) => void };

function Row({ row, onAction }: RowProps) {
  const { button } = row;
  const hint = useLastShown(row.hint);
  const label = useLastShown(button?.label ?? null);
  return (
    <div className={`setup-row ${row.dimmed ? "setup-row-dim" : ""}`}>
      <RowIcon icon={row.icon} />
      <div className="setup-text">
        <span className="setup-name">{row.name}</span>
        <Fold shows={row.hint !== null} className="setup-fold">
          <span className="type-hint block">{hint}</span>
        </Fold>
      </div>
      <button
        type="button"
        className={`setup-button glass-bright ${on(button !== null)}`}
        inert={button === null}
        onClick={() => {
          if (button !== null) onAction(button.action);
        }}
      >
        {label}
      </button>
    </div>
  );
}

const sendAction: Record<SetupAction, () => void> = {
  "open-accessibility": () => window.baymax.openAccessibilitySettings(),
  "ask-microphone": () => window.baymax.askMicrophone(),
  "open-microphone": () => window.baymax.openMicrophoneSettings(),
};

function useClickedRows(state: SetupState, open: boolean) {
  const [clicks, setClicks] = useState(noClicks);
  // A panel opened again brings the buttons back, so nobody who walked away is stuck on a Waiting row.
  useEffect(() => {
    if (open) setClicks(noClicks);
  }, [open]);
  const onAction = (action: SetupAction) => {
    setClicks((now) =>
      action === "open-accessibility"
        ? { ...now, accessibility: true }
        : { ...now, microphone: state.microphone },
    );
    sendAction[action]();
  };
  return { rows: setupRows(state, clicks), onAction };
}

function Strip({ ready, onClose }: { ready: boolean; onClose: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 flex h-8 items-center justify-between px-[14px]">
      <span className="type-label grid">
        <span className={`setup-word ${on(!ready)}`}>Setup</span>
        <span className={`setup-word ${on(ready)}`}>Ready</span>
      </span>
      <CloseControl onClose={onClose} />
    </div>
  );
}

type SetupChecklistProps = {
  state: SetupState;
  holdKeyLabel: string;
  notice: string | null;
  open: boolean; // the panel is open
  onClose: () => void;
};

// The first run's two permissions, in place of the panel's normal contents.
export function SetupChecklist(props: SetupChecklistProps) {
  const { state, holdKeyLabel, notice, open, onClose } = props;
  const { rows, onAction } = useClickedRows(state, open);
  const ready = setupReady(state);
  return (
    <>
      <Strip ready={ready} onClose={onClose} />
      <div className="setup">
        <div className="setup-card glass">
          <Row row={rows[0]} onAction={onAction} />
          <div className="setup-line" />
          <Row row={rows[1]} onAction={onAction} />
        </div>
        <Fold shows={ready} className="setup-ready">
          <p className="type-title setup-ready-line">
            Hold {holdKeyLabel} and say hello
          </p>
        </Fold>
        {notice !== null && <p className="type-body setup-notice">{notice}</p>}
      </div>
    </>
  );
}
