import { useEffect, useReducer, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { DisplayState, TaskId } from "../shared/cards";
import type { SetupState, VoicePhase } from "../shared/ipc";
import type { CardActions } from "./actions";
import { ReportPage } from "./cards/ReportPage";
import { TasksList } from "./cards/TasksList";
import { ChatList } from "./ChatList";
import { startMicrophone } from "./microphone";
import { NotchShell } from "./notch/NotchShell";
import { initialView, panelContent, viewReducer } from "./panel-contents";
import type { PanelContent, PanelTab, PanelViewEvent } from "./panel-contents";
import { startPlayback } from "./playback";
import { SetupChecklist } from "./SetupChecklist";
import { nextChecklistStage, setupCanEnd } from "./setup-steps";
import type { ChecklistStage } from "./setup-steps";
import { TextBox } from "./TextBox";
import { TopBar } from "./TopBar";

const emptyState: DisplayState = {
  tasks: [],
  chat: [],
  notice: null,
  keyMissing: false,
  muted: false,
  voiceAvailable: true,
};

const noSetup: SetupState = {
  needed: false,
  accessibility: "granted",
  microphone: "granted",
};

function useMainState() {
  const [holdKeyLabel, setHoldKeyLabel] = useState<string>("");
  const [display, setDisplay] = useState<DisplayState>(emptyState);
  const [phase, setPhase] = useState<VoicePhase>({ phase: "idle" });

  useEffect(() => {
    const stopDisplay = window.baymax.onDisplayState(setDisplay);
    const stopPhase = window.baymax.onVoicePhase(setPhase);
    window.baymax
      .getStartupInfo()
      .then((info) => setHoldKeyLabel(info.holdKeyLabel))
      .catch((error: unknown) => {
        console.error("[Renderer] Failed to get startup info:", error);
      });
    return () => {
      stopDisplay();
      stopPhase();
    };
  }, []);

  return { holdKeyLabel, display, phase };
}

type Setup = { state: SetupState; showing: boolean; ended: boolean };

// Setup ends on a move to listening with both granted, so a hold already running when the last grant lands does not end it.
function useSetup(phase: VoicePhase["phase"], keyMissing: boolean): Setup {
  const [state, setState] = useState(noSetup);
  const [ended, setEnded] = useState(false);
  useEffect(() => window.baymax.onSetupState(setState), []);
  const canEnd = useRef(false);
  canEnd.current = !ended && setupCanEnd(state, keyMissing);
  useEffect(() => {
    if (phase === "listening" && canEnd.current) setEnded(true);
  }, [phase]);
  return { state, showing: state.needed && !ended, ended };
}

function useChecklistShows(setup: Setup, open: boolean): boolean {
  const stage = useRef<ChecklistStage>("setup");
  stage.current = nextChecklistStage(stage.current, setup.ended, open);
  return (
    setup.showing || stage.current === "ended" || stage.current === "closed"
  );
}

type PanelBodyProps = {
  content: PanelContent;
  actions: CardActions;
  changeView: Dispatch<PanelViewEvent>;
};

function PanelBody({ content, actions, changeView }: PanelBodyProps) {
  const keptScroll = useRef(0);
  const onOpenReport = (taskId: TaskId) =>
    changeView({ kind: "open-report", taskId });
  switch (content.kind) {
    case "chat":
      return <ChatList rows={content.rows} onOpenReport={onOpenReport} />;
    case "tasks":
      return (
        <TasksList
          cards={content.cards}
          actions={actions}
          keptScroll={keptScroll}
          onOpenReport={onOpenReport}
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

type OpenPanelProps = {
  setup: Setup;
  open: boolean;
  onClose: () => void;
  display: DisplayState;
  holdKeyLabel: string;
  tab: PanelTab;
  content: PanelContent;
  changeView: Dispatch<PanelViewEvent>;
  onDraft: (text: string) => void;
};

function OpenPanel(props: OpenPanelProps) {
  const { setup, open, onClose, display, holdKeyLabel } = props;
  const { tab, content, changeView } = props;
  const actions: CardActions = window.baymax;
  const checklistShows = useChecklistShows(setup, open);
  if (checklistShows) {
    return (
      <SetupChecklist
        state={setup.state}
        holdKeyLabel={holdKeyLabel}
        notice={display.notice}
        open={open}
        onClose={onClose}
      />
    );
  }
  return (
    <>
      <TopBar
        tab={tab}
        onTab={(next) => changeView({ kind: "tab", tab: next })}
        state={display}
        setMuted={actions.setMuted}
        onClose={onClose}
      />
      <PanelBody content={content} actions={actions} changeView={changeView} />
      <TextBox
        submitQuestion={actions.submitQuestion}
        onDraft={props.onDraft}
        holdKeyLabel={holdKeyLabel}
      />
    </>
  );
}

export function App() {
  const { holdKeyLabel, display, phase } = useMainState();
  const setup = useSetup(phase.phase, display.keyMissing);
  const actions: CardActions = window.baymax;
  const [draft, setDraft] = useState("");
  const [view, changeView] = useReducer(viewReducer, initialView);
  const content = panelContent(view, display);
  useAudio();

  return (
    <NotchShell
      needsAccess={setup.showing || display.keyMissing}
      closeForHold={setup.ended}
      draft={draft}
      phase={phase}
      tasks={display.tasks}
      muted={display.muted}
      setMuted={actions.setMuted}
      openSource={actions.openSource}
      fullReportOpen={content.kind === "report"}
      onOpenResult={() => changeView({ kind: "open-result" })}
    >
      {(closePanel, open) => (
        <OpenPanel
          setup={setup}
          open={open}
          onClose={closePanel}
          display={display}
          holdKeyLabel={holdKeyLabel}
          tab={view.tab}
          content={content}
          changeView={changeView}
          onDraft={setDraft}
        />
      )}
    </NotchShell>
  );
}
