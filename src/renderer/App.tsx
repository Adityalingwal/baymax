import { useEffect, useReducer, useState } from "react";
import type { DisplayState } from "../shared/cards";
import type { VoicePhase } from "../shared/ipc";
import type { CardActions } from "./actions";
import { orderCards } from "./cards/list";
import { TaskCard } from "./cards/TaskCard";
import { startMicrophone } from "./microphone";
import { NotchShell } from "./notch/NotchShell";
import { initialView, viewReducer } from "./panel-contents";
import { startPlayback } from "./playback";
import { TextBox } from "./TextBox";
import { TopBar } from "./TopBar";

const emptyState: DisplayState = {
  tasks: [],
  chat: [],
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

function ChatList({ chat }: { chat: DisplayState["chat"] }) {
  if (chat.length === 0) return null;
  return (
    <section className="flex min-h-0 shrink flex-col gap-1 overflow-y-auto">
      {chat.map((entry) => (
        <p key={entry.id} className="type-body">
          {entry.text}
        </p>
      ))}
    </section>
  );
}

export function App() {
  const { accessibility, holdKeyLabel, display, phase } = useMainState();
  const actions: CardActions = window.baymax;
  const [draft, setDraft] = useState("");
  const [view, changeView] = useReducer(viewReducer, initialView);
  const cards = orderCards(display.tasks);

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
      tasks={display.tasks}
      muted={display.muted}
      setMuted={actions.setMuted}
      onOpenResult={() => changeView({ kind: "open-result" })}
    >
      {(closePanel) => (
        <>
          <TopBar
            tab={view.tab}
            onTab={(tab) => changeView({ kind: "tab", tab })}
            accessibility={accessibility}
            state={display}
            setMuted={actions.setMuted}
            onClose={closePanel}
            openAccessibilitySettings={() =>
              window.baymax.openAccessibilitySettings()
            }
          />
          {view.tab === "chat" && <ChatList chat={display.chat} />}
          {view.tab === "tasks" && cards.length === 0 && (
            <p className="type-empty">No tasks right now</p>
          )}
          {view.tab === "tasks" && cards.length > 0 && (
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
        </>
      )}
    </NotchShell>
  );
}
