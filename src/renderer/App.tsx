import { useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import type { DisplayState } from "../shared/cards";
import type { HoldState } from "../shared/ipc";
import type { CardActions } from "./actions";
import { TaskCard } from "./cards/TaskCard";
import { applyDemoAction, demoDisplayState, type DemoAction } from "./demo";
import { TextBox } from "./TextBox";
import { TopBar } from "./TopBar";

const emptyState: DisplayState = {
  tasks: [],
  notice: null,
  muted: false,
  voiceAvailable: true,
};

function useMainState() {
  const [hold, setHold] = useState<HoldState>("idle");
  const [accessibility, setAccessibility] = useState<boolean | null>(null);
  const [holdKeyLabel, setHoldKeyLabel] = useState<string>("");
  const [display, setDisplay] = useState<DisplayState>(emptyState);

  useEffect(() => {
    const stopHold = window.baymax.onHoldState(setHold);
    const stopDisplay = window.baymax.onDisplayState(setDisplay);
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
      stopHold();
      stopDisplay();
    };
  }, []);

  return { hold, accessibility, holdKeyLabel, display };
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

export function App() {
  const { hold, accessibility, holdKeyLabel, display } = useMainState();
  const demo = useDemoSwitch();
  const [demoState, dispatch] = useReducer(applyDemoAction, demoDisplayState);
  const demoCardActions = useMemo(() => demoActions(dispatch), [dispatch]);
  const state = demo ? demoState : display;
  const actions: CardActions = demo ? demoCardActions : window.baymax;

  return (
    <main className="flex h-screen flex-col bg-[#0B0B0C] text-zinc-100">
      <TopBar
        hold={hold}
        holdKeyLabel={holdKeyLabel}
        accessibility={accessibility}
        state={state}
        demo={demo}
        setMuted={actions.setMuted}
        openAccessibilitySettings={() =>
          window.baymax.openAccessibilitySettings()
        }
      />
      <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3">
        {state.tasks.map((card) => (
          <TaskCard key={card.taskId} card={card} actions={actions} />
        ))}
      </section>
      <TextBox submitQuestion={actions.submitQuestion} />
    </main>
  );
}
