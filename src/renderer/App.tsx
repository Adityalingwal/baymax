import { useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import type { DisplayState } from "../shared/cards";
import type { VoicePhase } from "../shared/ipc";
import type { CardActions } from "./actions";
import { orderCards } from "./cards/list";
import { TaskCard } from "./cards/TaskCard";
import { applyDemoAction, demoDisplayState, type DemoAction } from "./demo";
import { startMicrophone } from "./microphone";
import { NotchShell } from "./notch/NotchShell";
import { startPlayback } from "./playback";
import { TextBox } from "./TextBox";
import { TopBar } from "./TopBar";

const emptyState: DisplayState = {
  tasks: [],
  notice: null,
  muted: false,
  voiceAvailable: true,
};

function useMainState() {
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [holdKeyLabel, setHoldKeyLabel] = useState<string>("");
  const [display, setDisplay] = useState<DisplayState>(emptyState);
  const [phase, setPhase] = useState<VoicePhase>({ phase: "idle" });

  useEffect(() => {
    const stopDisplay = window.baymax.onDisplayState(setDisplay);
    const stopPhase = window.baymax.onVoicePhase(setPhase);
    window.baymax
      .getStartupInfo()
      .then((info) => {
        setAccessibility(info.accessibility);
        setHoldKeyLabel(info.holdKeyLabel);
      })
      .catch((error: unknown) => {
        console.error("[Renderer] Failed to get startup info:", error);
      });
    return () => {
      stopDisplay();
      stopPhase();
    };
  }, []);

  return { accessibility, holdKeyLabel, display, phase };
}

// Cmd+Shift+D or Ctrl+Shift+D; event.code, since Shift changes event.key per layout.
function useDemoSwitch(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.code !== "KeyD") return;
      event.preventDefault();
      setOn((value) => !value);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);
  return on;
}

function demoActions(dispatch: Dispatch<DemoAction>): CardActions {
  return {
    submitQuestion: (payload) => dispatch({ kind: "submitQuestion", payload }),
    answerQuestion: (payload) => dispatch({ kind: "answerQuestion", payload }),
    cancelTask: (payload) => dispatch({ kind: "cancelTask", payload }),
    retryTask: (payload) => dispatch({ kind: "retryTask", payload }),
    closeCard: (payload) => dispatch({ kind: "closeCard", payload }),
    setCardFolded: (payload) => dispatch({ kind: "setCardFolded", payload }),
    openSource: (payload) => {
      console.log("[Demo] openSource", payload);
      dispatch({ kind: "openSource", payload });
    },
    setMuted: (payload) => dispatch({ kind: "setMuted", payload }),
  };
}

// The demo display state and its local actions while Cmd+Shift+D is on; main's state and window.baymax otherwise.
function useShownState(display: DisplayState) {
  const demo = useDemoSwitch();
  const [demoState, dispatch] = useReducer(applyDemoAction, demoDisplayState);
  const demoCardActions = useMemo(() => demoActions(dispatch), [dispatch]);
  const state = demo ? demoState : display;
  const actions: CardActions = demo ? demoCardActions : window.baymax;
  return { demo, state, actions };
}

export function App() {
  const { accessibility, holdKeyLabel, display, phase } = useMainState();
  const { demo, state, actions } = useShownState(display);
  const [draft, setDraft] = useState(false);
  const cards = orderCards(state.tasks);

  useEffect(() => {
    const stopMicrophone = startMicrophone(window.baymax);
    const stopPlayback = startPlayback(window.baymax);
    return () => {
      stopMicrophone();
      stopPlayback();
    };
  }, []);

  return (
    <NotchShell
      needsAccess={accessibility === false}
      draft={draft}
      phase={phase}
      tasks={state.tasks}
      setMuted={actions.setMuted}
    >
      <TopBar
        accessibility={accessibility}
        state={state}
        demo={demo}
        setMuted={actions.setMuted}
        openAccessibilitySettings={() =>
          window.baymax.openAccessibilitySettings()
        }
      />
      {cards.length > 0 && (
        <section className="flex min-h-0 shrink flex-col gap-3 overflow-y-auto">
          {cards.map((card) => (
            <TaskCard key={card.taskId} card={card} actions={actions} />
          ))}
        </section>
      )}
      <TextBox
        submitQuestion={actions.submitQuestion}
        onDraft={setDraft}
        holdKeyLabel={holdKeyLabel}
      />
    </NotchShell>
  );
}
