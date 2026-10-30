import type { DisplayState } from "../shared/cards";
import type { CardActions } from "./actions";
import { statusLine } from "./cards/list";
import { SpeakerIcon } from "./notch/VoicePill";

function AccessibilityHint({ openSettings }: { openSettings: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="type-body">
        Grant Accessibility access to the running app, then restart. During{" "}
        <code>npm start</code> macOS may list it as Electron; packaged builds
        show Baymax.
      </p>
      <button
        type="button"
        className="action action-secondary glass"
        onClick={openSettings}
      >
        Open Accessibility settings
      </button>
    </div>
  );
}

type MuteProps = { muted: boolean; setMuted: CardActions["setMuted"] };

// The panel's mute switch until the panel-open voice rail exists; reachable muted or not, speaking or not.
function MuteToggle({ muted, setMuted }: MuteProps) {
  return (
    <button
      type="button"
      aria-label={muted ? "Unmute Baymax" : "Mute Baymax"}
      aria-pressed={muted}
      className="glass grid h-[22px] w-[22px] shrink-0 cursor-pointer place-items-center rounded-full"
      onClick={() => setMuted({ muted: !muted })}
    >
      <SpeakerIcon crossed={muted} />
    </button>
  );
}

// Half the strip's content box less half the notch: on a narrow panel the status never runs behind the notch.
const rightWing = { maxWidth: "calc(50% - var(--notch-width) / 2)" };

type TopBarProps = {
  accessibility: boolean | null;
  state: DisplayState;
  setMuted: CardActions["setMuted"];
  openAccessibilitySettings: () => void;
};

// The 32 pt top strip (content only in its wings), then the Accessibility hint and the notice when there is one.
export function TopBar(props: TopBarProps) {
  const { accessibility, state, setMuted } = props;
  const needsAccess = accessibility === false;
  return (
    <>
      <div className="absolute inset-x-0 top-0 flex h-8 items-center justify-between px-[14px]">
        <span />
        <div
          className="flex min-w-0 items-center justify-end gap-2"
          style={rightWing}
        >
          <span className="type-status min-w-0 truncate">
            {statusLine(state.tasks)}
          </span>
          <MuteToggle muted={state.muted} setMuted={setMuted} />
        </div>
      </div>
      {(needsAccess || state.notice !== null) && (
        <header className="flex flex-col gap-2">
          {needsAccess && (
            <AccessibilityHint openSettings={props.openAccessibilitySettings} />
          )}
          {state.notice !== null && (
            <p className="type-body truncate">{state.notice}</p>
          )}
        </header>
      )}
    </>
  );
}
