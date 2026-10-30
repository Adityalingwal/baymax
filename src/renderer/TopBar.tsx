import type { DisplayState } from "../shared/cards";
import type { CardActions } from "./actions";
import { SpeakerIcon } from "./notch/VoicePill";
import type { PanelTab } from "./panel-contents";

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

const tabNames: { tab: PanelTab; name: string }[] = [
  { tab: "chat", name: "Chat" },
  { tab: "tasks", name: "Tasks" },
];

type TabsProps = { tab: PanelTab; onTab: (tab: PanelTab) => void };

function Tabs({ tab, onTab }: TabsProps) {
  return (
    <div role="tablist" className="glass flex h-[22px] rounded-full p-0.5">
      {tabNames.map(({ tab: shown, name }) => (
        <button
          key={shown}
          type="button"
          role="tab"
          aria-selected={tab === shown}
          className={`panel-tab ${tab === shown ? "panel-tab-on" : ""}`}
          onClick={() => onTab(shown)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

const roundButton =
  "glass grid h-[22px] w-[22px] shrink-0 cursor-pointer place-items-center rounded-full";

type MuteProps = { muted: boolean; setMuted: CardActions["setMuted"] };

// Reachable muted or not, speaking or not.
function MuteToggle({ muted, setMuted }: MuteProps) {
  return (
    <button
      type="button"
      aria-label={muted ? "Unmute Baymax" : "Mute Baymax"}
      aria-pressed={muted}
      className={roundButton}
      onClick={() => setMuted({ muted: !muted })}
    >
      <SpeakerIcon crossed={muted} />
    </button>
  );
}

function CloseControl({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close panel"
      className={roundButton}
      onClick={onClose}
    >
      <svg viewBox="0 0 10 10" width={10} height={10} aria-hidden="true">
        <path
          d="M1.5 1.5l7 7M8.5 1.5l-7 7"
          stroke="#fff"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

type TopBarProps = TabsProps & {
  accessibility: boolean | null;
  state: DisplayState;
  setMuted: CardActions["setMuted"];
  onClose: () => void;
  openAccessibilitySettings: () => void;
};

// The 32 pt top strip (content only in its wings), then the Accessibility hint and the notice when there is one.
export function TopBar(props: TopBarProps) {
  const { accessibility, state, setMuted } = props;
  const needsAccess = accessibility === false;
  return (
    <>
      <div className="absolute inset-x-0 top-0 flex h-8 items-center justify-between px-[14px]">
        <Tabs tab={props.tab} onTab={props.onTab} />
        <div className="flex items-center gap-2">
          <MuteToggle muted={state.muted} setMuted={setMuted} />
          <CloseControl onClose={props.onClose} />
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
