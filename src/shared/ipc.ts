import type { DisplayState, TaskId, UtteranceId } from "./cards";

export const ipcChannels = {
  getStartupInfo: "get-startup-info",
  openAccessibilitySettings: "open-accessibility-settings",
  displayState: "display-state",
  getDisplayState: "get-display-state",
  submitQuestion: "submit-question",
  cancelTask: "cancel-task",
  retryTask: "retry-task",
  openSource: "open-source",
  setMuted: "set-muted",
  recording: "recording",
  micAudio: "mic-audio",
  speech: "speech",
  speechChunk: "speech-chunk",
  speechEnd: "speech-end",
  stopPlayback: "stop-playback",
  playbackFinished: "playback-finished",
  windowShape: "window-shape",
  getWindowShape: "get-window-shape",
  setMouseCapture: "set-mouse-capture",
  voicePhase: "voice-phase",
  getVoicePhase: "get-voice-phase",
} as const;

export type HoldState = "idle" | "listening";

// The notch size is estimated from the display width, not detected.
export type WindowShape = {
  notched: boolean;
  notchWidth: number;
  notchHeight: number;
};

export type StartupInfo = {
  accessibility: boolean | null;
  holdKeyLabel: string;
};

export type LineId = string;

// What a spoken line is: the front call's line, a clarifying question, a done task's answer, an incomplete task's line, a failure or a notice.
export type SpokenKind =
  "talk" | "question" | "answer" | "incomplete" | "failure" | "notice";

// The line whose audio is playing; taskId is null for a notice.
export type SpeakingLine = {
  lineId: LineId;
  taskId: TaskId | null;
  kind: SpokenKind;
};

// Main's one voice phase for the notch: thinking is a turn waiting for its transcript or first audio.
export type VoicePhase =
  | { phase: "idle" }
  | { phase: "listening" }
  | { phase: "thinking" }
  | { phase: "speaking"; line: SpeakingLine };

// Main starts and stops the recording, since only main sees the hold key.
export type RecordingCommand =
  | { type: "start"; utteranceId: UtteranceId }
  | { type: "stop"; utteranceId: UtteranceId };

export type MicFailure = "permissionDenied" | "noMicrophone" | "error";

// The held microphone as 16 kHz mono 16-bit little-endian PCM frames, then exactly one end or failure.
export type MicAudio =
  | { type: "frames"; utteranceId: UtteranceId; pcm: ArrayBuffer }
  | { type: "end"; utteranceId: UtteranceId }
  | { type: "failed"; utteranceId: UtteranceId; reason: MicFailure };

// A whole clip from the REST call.
export type SpeechLine = {
  lineId: LineId;
  audio: ArrayBuffer;
  mimeType: string;
};

// Streamed speech: 16-bit mono PCM chunks of one line in seq order, then its end.
export type SpeechChunk = {
  lineId: LineId;
  seq: number;
  pcm: ArrayBuffer;
  sampleRate: number;
};
export type SpeechEnd = { lineId: LineId };

// A streamed line plays this long after its first chunk: Aura's first burst is 200 ms, then a gap of up to 314 ms measured.
export const speechStartBufferMs = 350;

export type SubmitQuestion = { text: string };
export type TaskAction = { taskId: TaskId };
// Main opens the URL only if it is one of that task's read sources.
export type OpenSource = { taskId: TaskId; url: string };
export type SetMuted = { muted: boolean };
// The line id lets a late stop never cut the next line.
export type StopPlayback = { lineId: LineId };
export type PlaybackFinished = {
  lineId: LineId;
  outcome: "ended" | "stopped" | "failed";
};
// Captured: clicks land on the panel; released: they pass through to the app below.
export type SetMouseCapture = { captured: boolean };

// Payload of each renderer -> main channel, so main's handlers use the same types.
export type RendererToMain = {
  [ipcChannels.submitQuestion]: SubmitQuestion;
  [ipcChannels.cancelTask]: TaskAction;
  [ipcChannels.retryTask]: TaskAction;
  [ipcChannels.openSource]: OpenSource;
  [ipcChannels.setMuted]: SetMuted;
  [ipcChannels.micAudio]: MicAudio;
  [ipcChannels.playbackFinished]: PlaybackFinished;
  [ipcChannels.setMouseCapture]: SetMouseCapture;
};

// Payload of each main -> renderer channel.
export type MainToRenderer = {
  [ipcChannels.displayState]: DisplayState;
  [ipcChannels.recording]: RecordingCommand;
  [ipcChannels.speech]: SpeechLine;
  [ipcChannels.speechChunk]: SpeechChunk;
  [ipcChannels.speechEnd]: SpeechEnd;
  [ipcChannels.stopPlayback]: StopPlayback;
  [ipcChannels.windowShape]: WindowShape;
  [ipcChannels.voicePhase]: VoicePhase;
};

export type BaymaxApi = {
  getStartupInfo: () => Promise<StartupInfo>;
  openAccessibilitySettings: () => void;
  onDisplayState: (callback: (state: DisplayState) => void) => () => void;
  submitQuestion: (payload: SubmitQuestion) => void;
  cancelTask: (payload: TaskAction) => void;
  retryTask: (payload: TaskAction) => void;
  openSource: (payload: OpenSource) => void;
  setMuted: (payload: SetMuted) => void;
  onRecording: (callback: (command: RecordingCommand) => void) => () => void;
  sendMicAudio: (audio: MicAudio) => void;
  onSpeech: (callback: (line: SpeechLine) => void) => () => void;
  onSpeechChunk: (callback: (chunk: SpeechChunk) => void) => () => void;
  onSpeechEnd: (callback: (end: SpeechEnd) => void) => () => void;
  onStopPlayback: (callback: (payload: StopPlayback) => void) => () => void;
  reportPlaybackFinished: (payload: PlaybackFinished) => void;
  onWindowShape: (callback: (shape: WindowShape) => void) => () => void;
  setMouseCapture: (payload: SetMouseCapture) => void;
  onVoicePhase: (callback: (phase: VoicePhase) => void) => () => void;
};
