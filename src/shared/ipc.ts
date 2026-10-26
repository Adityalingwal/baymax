import type {
  ClarifyingReply,
  DisplayState,
  QuestionId,
  TaskId,
  UtteranceId,
} from "./cards";

export const ipcChannels = {
  holdState: "hold-state",
  getHoldState: "get-hold-state",
  getStartupInfo: "get-startup-info",
  openAccessibilitySettings: "open-accessibility-settings",
  displayState: "display-state",
  getDisplayState: "get-display-state",
  submitQuestion: "submit-question",
  answerQuestion: "answer-question",
  cancelTask: "cancel-task",
  retryTask: "retry-task",
  closeCard: "close-card",
  setCardFolded: "set-card-folded",
  openSource: "open-source",
  setMuted: "set-muted",
  recording: "recording",
  sendClip: "send-clip",
  speech: "speech",
  stopPlayback: "stop-playback",
  playbackFinished: "playback-finished",
} as const;

export type HoldState = "idle" | "listening";

export type StartupInfo = {
  accessibility: boolean | null;
  holdKeyLabel: string;
};

export type LineId = string;

// Main starts and stops the recording, since only main sees the hold key.
export type RecordingCommand =
  | { type: "start"; utteranceId: UtteranceId }
  | { type: "stop"; utteranceId: UtteranceId };

export type Clip =
  | {
      utteranceId: UtteranceId;
      outcome: "recorded";
      audio: ArrayBuffer;
      mimeType: string;
    }
  | {
      utteranceId: UtteranceId;
      outcome: "failed";
      reason: "permissionDenied" | "noMicrophone" | "error";
    };

export type SpeechLine = {
  lineId: LineId;
  audio: ArrayBuffer;
  mimeType: string;
};

export type SubmitQuestion = { text: string };
export type AnswerQuestion = {
  taskId: TaskId;
  questionId: QuestionId;
  reply: ClarifyingReply;
};
export type TaskAction = { taskId: TaskId };
export type SetCardFolded = { taskId: TaskId; folded: boolean };
// Main opens the URL only if it is one of that task's read sources.
export type OpenSource = { taskId: TaskId; url: string };
export type SetMuted = { muted: boolean };
// The line id lets a late stop never cut the next line.
export type StopPlayback = { lineId: LineId };
export type PlaybackFinished = {
  lineId: LineId;
  outcome: "ended" | "stopped" | "failed";
};

// Payload of each renderer -> main channel, so main's handlers use the same types.
export type RendererToMain = {
  [ipcChannels.submitQuestion]: SubmitQuestion;
  [ipcChannels.answerQuestion]: AnswerQuestion;
  [ipcChannels.cancelTask]: TaskAction;
  [ipcChannels.retryTask]: TaskAction;
  [ipcChannels.closeCard]: TaskAction;
  [ipcChannels.setCardFolded]: SetCardFolded;
  [ipcChannels.openSource]: OpenSource;
  [ipcChannels.setMuted]: SetMuted;
  [ipcChannels.sendClip]: Clip;
  [ipcChannels.playbackFinished]: PlaybackFinished;
};

// Payload of each main -> renderer channel.
export type MainToRenderer = {
  [ipcChannels.holdState]: HoldState;
  [ipcChannels.displayState]: DisplayState;
  [ipcChannels.recording]: RecordingCommand;
  [ipcChannels.speech]: SpeechLine;
  [ipcChannels.stopPlayback]: StopPlayback;
};

export type BaymaxApi = {
  onHoldState: (callback: (state: HoldState) => void) => () => void;
  getStartupInfo: () => Promise<StartupInfo>;
  openAccessibilitySettings: () => void;
  onDisplayState: (callback: (state: DisplayState) => void) => () => void;
  submitQuestion: (payload: SubmitQuestion) => void;
  answerQuestion: (payload: AnswerQuestion) => void;
  cancelTask: (payload: TaskAction) => void;
  retryTask: (payload: TaskAction) => void;
  closeCard: (payload: TaskAction) => void;
  setCardFolded: (payload: SetCardFolded) => void;
  openSource: (payload: OpenSource) => void;
  setMuted: (payload: SetMuted) => void;
  onRecording: (callback: (command: RecordingCommand) => void) => () => void;
  sendClip: (clip: Clip) => void;
  onSpeech: (callback: (line: SpeechLine) => void) => () => void;
  onStopPlayback: (callback: (payload: StopPlayback) => void) => () => void;
  reportPlaybackFinished: (payload: PlaybackFinished) => void;
};
