import { useEffect, useReducer, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { DisplayState } from "../shared/cards";
import type { VoicePhase } from "../shared/ipc";
import type { CardActions } from "./actions";
import { ReportPage } from "./cards/ReportPage";
import { TasksList } from "./cards/TasksList";
import { ChatList } from "./ChatList";
import { startMicrophone } from "./microphone";
import { NotchShell } from "./notch/NotchShell";
import { initialView, panelContent, viewReducer } from "./panel-contents";
import type { PanelContent, PanelViewEvent } from "./panel-contents";
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

type PanelBodyProps = {
  content: PanelContent;
  actions: CardActions;
  changeView: Dispatch<PanelViewEvent>;
};

function PanelBody({ content, actions, changeView }: PanelBodyProps) {
  const keptScroll = useRef(0);
  switch (content.kind) {
    case "chat":
      return <ChatList rows={content.rows} />;
    case "tasks":
      return (
        <TasksList
          cards={content.cards}
          actions={actions}
          keptScroll={keptScroll}
          onOpenReport={(taskId) => changeView({ kind: "open-report", taskId })}
        />
      );
    case "report":
      return (
        <ReportPage
          key={content.card.taskId}
          card={content.card}
          report={content.report}
          openSource={actions.openSource}
          onBack={() => changeView({ kind: "back" })}
        />
      );
  }
}

function useAudio() {
  useEffect(() => {
    const stopMicrophone = startMicrophone(window.baymax);
    const stopPlayback = startPlayback(window.baymax);
    return () => {
      stopMicrophone();
      stopPlayback();
    };
  }, []);
}

export function App() {
  const { accessibility, holdKeyLabel, display, phase } = useMainState();
  const actions: CardActions = window.baymax;
  const [draft, setDraft] = useState("");
  const [view, changeView] = useReducer(viewReducer, initialView);
  const content = panelContent(view, display);
  useAudio();

  return (
    <NotchShell
      needsAccess={accessibility === false}
      draft={draft}
      phase={phase}
      tasks={display.tasks}
      muted={display.muted}
      setMuted={actions.setMuted}
      openSource={actions.openSource}
      fullReportOpen={content.kind === "report"}
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
          <PanelBody
            content={content}
            actions={actions}
            changeView={changeView}
          />
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
