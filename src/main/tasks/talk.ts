import type { TaskId, TaskState, UtteranceId } from "../../shared/cards";
import type {
  FailureKind,
  RecentExchange,
  WaitingQuestion,
} from "../../shared/engine";

// A task the talker hears about, so its reply fits what is already running or waiting.
export type TaskSummary = {
  taskId: TaskId;
  state: TaskState;
  words: string;
  sayBack: string | null;
};

// What main asks the talker to say: its reply to new words, or a clarifying question or result in its own words.
export type TalkRequest =
  | {
      kind: "reply";
      taskId: TaskId;
      utteranceId: UtteranceId | null; // null for a typed question
      words: string;
      recent: RecentExchange[];
      tasks: TaskSummary[];
      waiting: WaitingQuestion | null;
    }
  | { kind: "question"; taskId: TaskId; question: string; choices: string[] }
  | { kind: "result"; taskId: TaskId; text: string };

// How the talker's reply to new words went; a chat card waits for it.
export type TalkerReply =
  { kind: "said"; text: string } | { kind: "failed"; failure: FailureKind };
