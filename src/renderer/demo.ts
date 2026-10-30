import type { DisplayState, TaskCard, TaskId } from "../shared/cards";
import type { CardActions } from "./actions";
import { canCancel } from "./cards/forms";

// One member per CardActions method, carrying that method's payload.
export type DemoAction = {
  [K in keyof CardActions]: { kind: K; payload: Parameters<CardActions[K]>[0] };
}[keyof CardActions];

function demoCard(taskId: TaskId, fields: Partial<TaskCard>): TaskCard {
  return {
    taskId,
    state: "thinking",
    words: "",
    title: null,
    parentTaskId: null,
    line: null,
    spokenLine: null,
    step: null,
    sourcesRead: 0,
    answer: null,
    canRetry: false,
    ...fields,
  };
}

const hermesAnswer = [
  "## How Hermes agent works",
  "",
  "Hermes runs a **plan, act, check** loop around one model:",
  "",
  "- It plans the next step from the goal.",
  "- It calls a tool, such as search or a shell.",
  "- It checks the result before it moves on.",
  "",
  "### Memory",
  "",
  "It keeps notes between sessions, as the [project README](https://github.com/example/hermes) describes. A <b>raw HTML tag</b> is skipped, and so is this image: ![diagram](https://example.com/diagram.png)",
  "",
  "See also the [design notes](https://docs.example.com/hermes/design).",
].join("\n");

const hermesSources = [
  {
    id: "s1",
    url: "https://github.com/example/hermes",
    title: "Hermes README",
  },
  {
    id: "s2",
    url: "https://docs.example.com/hermes/design",
    title: "Hermes design notes",
  },
  {
    id: "s3",
    url: "https://www.github.com/example/hermes/issues/12",
    title: "Memory issue",
  },
  {
    id: "s4",
    url: "https://news.example.org/hermes-launch",
    title: "Hermes launch post",
  },
];

const demoCards: TaskCard[] = [
  demoCard("demo-1", {
    state: "done",
    words: "How does Hermes agent work inside?",
    title: "How Hermes agent works inside",
    sourcesRead: 4,
    answer: { cardText: hermesAnswer, sources: hermesSources },
  }),
  demoCard("demo-2", {
    state: "done",
    words: "Thanks, that helps",
    answer: {
      cardText: "Glad it helped. Ask me anything else.",
      sources: [],
    },
  }),
  demoCard("demo-3", {
    state: "failed",
    words: "Compare the pricing of three search APIs",
    line: "That task reached a limit before it had an answer. Try a narrower question or try again.",
    sourcesRead: 3,
    answer: {
      cardText:
        "Two of the three APIs charge per request; see the table on each site.",
      sources: hermesSources.slice(0, 2),
    },
  }),
  demoCard("demo-4", {
    state: "cancelled",
    words: "Book me a flight to Delhi",
    line: "I can't do that yet in this version.",
  }),
  demoCard("demo-5", {
    state: "cancelling",
    words: "Find every paper on voice agents",
    step: "searching: voice agent papers",
    sourcesRead: 1,
  }),
  demoCard("demo-6", {
    state: "running",
    words: "How is Hermes different from Claude Code?",
    line: "Let me check.",
    step: "reading github.com",
    sourcesRead: 3,
  }),
  demoCard("demo-7", {
    state: "queued",
    words: "What does the Exa search API cost?",
    line: "Okay, I'll look at that after the current one.",
  }),
  demoCard("demo-8", {
    state: "clarifying",
    words: "Find me a good laptop",
  }),
  demoCard("demo-9", {
    state: "thinking",
    words: "Summarise today's AI news",
  }),
  demoCard("demo-10", {
    state: "thinking",
    words: "Explain how Deepgram streaming works",
    line: "I can't reach my models right now. Try again in a few minutes.",
    canRetry: true,
  }),
];

export const demoDisplayState: DisplayState = {
  tasks: demoCards,
  chat: [],
  notice: "This is the demo display state. Press Cmd+Shift+D to leave it.",
  // Muted, so the top strip's toggle shows its muted look; a click unmutes.
  muted: true,
  voiceAvailable: true,
};

function changeCard(
  state: DisplayState,
  taskId: TaskId,
  change: (card: TaskCard) => TaskCard,
): DisplayState {
  const index = state.tasks.findIndex((card) => card.taskId === taskId);
  if (index === -1) return state;
  const next = change(state.tasks[index]);
  if (next === state.tasks[index]) return state;
  const tasks = state.tasks.slice();
  tasks[index] = next;
  return { ...state, tasks };
}

function nextDemoId(state: DisplayState): TaskId {
  const numbers = state.tasks.map((card) => {
    const match = /^demo-(\d+)$/.exec(card.taskId);
    return match ? Number(match[1]) : 0;
  });
  return `demo-${Math.max(0, ...numbers) + 1}`;
}

export function applyDemoAction(
  state: DisplayState,
  action: DemoAction,
): DisplayState {
  switch (action.kind) {
    case "submitQuestion": {
      const card = demoCard(nextDemoId(state), { words: action.payload.text });
      return { ...state, tasks: [...state.tasks, card] };
    }
    case "cancelTask":
      return changeCard(state, action.payload.taskId, (card) =>
        canCancel(card.state) ? { ...card, state: "cancelling" } : card,
      );
    case "retryTask":
      return changeCard(state, action.payload.taskId, (card) =>
        card.canRetry ? { ...card, canRetry: false } : card,
      );
    case "setMuted":
      return { ...state, muted: action.payload.muted };
    case "openSource":
      return state;
  }
}
