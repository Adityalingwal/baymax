import type { DisplayState } from "../shared/cards";
import type { HoldState } from "../shared/ipc";
import type { CardActions } from "./actions";

function AccessibilityHint({ openSettings }: { openSettings: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <p className="text-xs text-amber-300">
        Grant Accessibility access to the running app, then restart. During{" "}
        <code>npm start</code> macOS may list it as Electron; packaged builds
        show Baymax.
      </p>
      <button
        type="button"
        className="cursor-pointer rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-100 hover:bg-zinc-700"
        onClick={openSettings}
      >
        Open Accessibility settings
      </button>
    </div>
  );
}

type MuteProps = {
  muted: boolean;
  voiceAvailable: boolean;
  setMuted: CardActions["setMuted"];
};

function MuteSwitch({ muted, voiceAvailable, setMuted }: MuteProps) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {!voiceAvailable && (
        <span className="text-xs text-zinc-400">Voice off</span>
      )}
      <button
        type="button"
        aria-pressed={muted}
        className={
          muted
            ? "cursor-pointer rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900"
            : "cursor-pointer rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-100 hover:bg-zinc-700"
        }
        onClick={() => setMuted({ muted: !muted })}
      >
        {muted ? "Muted" : "Mute"}
      </button>
    </div>
  );
}

type TopBarProps = {
  hold: HoldState;
  holdKeyLabel: string;
  accessibility: boolean | null;
  state: DisplayState;
  demo: boolean;
  setMuted: CardActions["setMuted"];
  openAccessibilitySettings: () => void;
};

function holdText(hold: HoldState, holdKeyLabel: string): string {
  if (hold === "listening") return "Listening…";
  if (holdKeyLabel === "") return "";
  return `Hold ${holdKeyLabel} to talk, or type below.`;
}

export function TopBar(props: TopBarProps) {
  const { hold, holdKeyLabel, accessibility, state, demo, setMuted } = props;
  const { openAccessibilitySettings } = props;
  const listening = hold === "listening";
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p
          className={`min-w-0 flex-1 truncate text-sm ${listening ? "font-medium text-emerald-400" : "text-zinc-400"}`}
        >
          {holdText(hold, holdKeyLabel)}
        </p>
        {demo && (
          <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
            Demo
          </span>
        )}
        <MuteSwitch
          muted={state.muted}
          voiceAvailable={state.voiceAvailable}
          setMuted={setMuted}
        />
      </div>
      {accessibility === false && (
        <AccessibilityHint openSettings={openAccessibilitySettings} />
      )}
      {state.notice !== null && (
        <p className="text-sm text-zinc-300">{state.notice}</p>
      )}
    </header>
  );
}
