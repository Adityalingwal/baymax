# Architecture

This file describes how Baymax is built today. Setup is in [README.md](../README.md) and the working rules are in [AGENTS.md](../AGENTS.md). If this file and the code ever differ, the code wins.

## What Baymax is

Baymax is a voice-first assistant for macOS, built with Electron, TypeScript and React. It sits over whatever app you are using, and asking by voice or getting an answer does not take the focus from that app.

1. You hold the left Option key and ask out loud, or you type into the panel.
2. Baymax says something right away: the whole answer, one question when a detail is missing, or that it has started.
3. Bigger questions run in the background as a task while you keep working.
4. When the task is done, Baymax speaks a short line and shows a card, with the full report and its sources behind a button.

Baymax gives information only. It finds and explains, and it takes no action outside the app, such as sending email or editing files.

## How a question flows

```
hold key -> microphone -> Flux -> words      typed words
                                    |             |
                                    v             v
                     talker: one spoken line, then a decision
                                    |
                reply | ask | stop | retry | work
                                         |      |
                                         v      v
                  worker -> search and read -> done check
                                    |
                                    v
                    spoken line, card, report and sources
```

Spoken and typed words take the same path. Each one gets one talker call, even while a task runs. The talker's decision is one of five routes:

- **reply:** the spoken line was the whole answer. No worker runs and no card appears.
- **ask:** the spoken line is one question. The next words can answer it, and there is still no card.
- **work:** main creates a card and starts the task, or queues it. One task runs at a time and up to three wait.
- **stop:** main cancels the named task, the same way the stop button on its card does.
- **retry:** the words say yes to an offer to try a failed task again, so the same task runs again.

A follow-up names its earlier task, and main hands the worker that task's result.

## The parts and who owns what

- **Main** (`src/index.ts`, `src/main/`) runs the hold key, the window, the Deepgram calls, speech and the talker. It owns the shown state: the task list, the cards, the queue, the Chat list and the conversation history.
- **Renderer** (`src/renderer/`) records the microphone, plays audio and draws the panel. It owns nothing and shows what main sends.
- **Engine** (`src/engine/`) runs tasks inside the main process, behind a port. It owns the running task's state and keeps nothing across tasks, so each `runTask` message carries what the task needs. Its core is shared, and a plug adds one kind of work. Research is the only plug today.
- **Providers** (`src/providers/`) hold the Anthropic, Deepgram and Exa calls that main and the engine share.
- **Shared contracts** (`src/shared/`, `src/preload.ts`) define the messages on each link and the types both links carry.

The renderer reaches main only through `window.baymax` from the preload script, and it never talks to the engine. Main and the engine talk only through the port, with plain JSON messages, so the engine can later move to its own process without changing either side. The full rules are in [AGENTS.md](../AGENTS.md#process-boundaries).

## Voice

**Hearing.** The microphone is on only while the key is held. The renderer sends 16 kHz PCM frames to main, and main sends them to Deepgram Flux (`flux-general-en`) over a WebSocket kept open from the start. At release, main ends the turn and Flux's final transcript becomes the words. A very short hold, or one where another key was pressed, is dropped.

**Hearing fallback.** The held audio goes whole to Deepgram's pre-recorded Nova-3 call when the Flux socket is not open at the end of the hold or closes during the turn, when no final transcript comes soon after release, or when Flux returns nothing but the hold's sound level shows speech. A partial transcript is never used, since it can be a question cut short.

**Speaking.** All speech goes through one owner in main (`src/main/speech.ts`), one line at a time. Text goes sentence by sentence to Deepgram Aura-2 (`aura-2-thalia-en`) over its own open WebSocket, and the renderer plays the audio. Pressing the key silences Baymax, and mute turns speech off. A task's result line waits for a quiet moment, so a new question is answered first.

**Speaking fallback.** When the Aura socket is not open, or closes before any audio came, the whole line goes to the Aura-2 REST call. When it closes after some audio, the rest of that line is dropped and not replayed.

## Talker, worker, done check

**Talker** (`src/main/talker.ts`). One streamed call to `claude-fable-5-1` at low effort, in main. It writes a short line that is spoken as it arrives, then calls the `decide` tool once. It reads the recent conversation, the date, the words, the recent tasks, what is running and waiting, and any waiting question. Main checks the decision in plain code (`src/main/tasks/decision.ts`) before anything starts; a decision that fails the check starts nothing and gives a fixed line.

**Worker** (`src/engine/plugs/research/`). `claude-sonnet-5-5` with adaptive thinking at medium effort, on our own loop over the Anthropic SDK. It reads the date, the user's exact words, the talker's one-line goal and, for a follow-up, the earlier result. It never sees the whole conversation and never asks the user anything. It has two tools:

- `search` asks Exa for results.
- `read` gets a page from Exa Contents. If Exa has no usable text it asks for a fresh copy, and after that, or when an Exa call fails, Baymax's own plain reader tries the page.

URL rules refuse local and private addresses, URLs with credentials, and x.com, linkedin.com and reddit.com. Page text is treated as data, never as instructions. Each task has limits on model calls, searches, time and cost (`src/engine/core/limits.ts`). A run that hits a limit, or whose search keeps failing, gets one last call to answer if it has read at least one page.

**Done check** (`checkAnswer` in `src/engine/plugs/research/answer.ts`). Plain code, with no model. The worker's answer has four fields: `report`, `line`, `sourceIds` and `nothingFound`. An answer is valid when it has a line and at least one source id of a page really read; other ids are dropped. It does not judge whether the pages support the report. A bad answer gets exactly one rewrite, and a second bad answer fails the task.

**Failures.** A failed task keeps its card, with its cause and a Retry button, and gets its own talker call so Baymax tells it in its own words. A failing provider gives a line that names the cause and the fix, and the app keeps running. An uncaught exception stops the work, shows a restart line and relaunches the app, and a second failure soon after that exits instead of looping.

**Memory.** V1 has no database. Main keeps the tasks, their answers for follow-ups, the Chat list and a bounded conversation history in memory. The engine holds a task's pages and messages only while it runs. Quitting the app loses all of it.

## The panel

One fixed, transparent window sits over the notch, shown without taking focus, and clicks pass through it except on what is drawn. The window never resizes; only the black shape inside it moves. Main reads the real notch size from macOS, and a screen with no notch gets a small pill at rest.

**Open panel.** It opens when the pointer rests on the notch and closes when the pointer leaves, on Esc in its field or with its close control. It is 520 wide on Chat, Tasks and the report page, and wider only when a wide notch needs it. Its height follows its content up to a limit, and past that the active view scrolls. The top strip holds the Chat and Tasks tabs, mute and close, and the bottom holds the field for typing.

- **Chat** holds the whole conversation: your words, every spoken line (a task's question and start line included), failure lines and each task's result line. A result with a report has an "Open report" button.
- **Tasks** lists running and queued cards first, each with a stop button, and then finished tasks with the last to finish first. A running card shows its latest step. A done card shows its title and spoken line, and a button opens its report page. A failed card shows its cause and Retry.

**Closed panel.** Nothing shows at rest except the notch itself. The notch grows into the voice pill (Listening, Thinking, Speaking), or a ring while tasks run or wait.

**Answer island.** When a task's result line speaks with the panel closed, the pill grows into the island: the task's title and its spoken line. If there is a report, a button opens it inside the island. A click elsewhere on the card opens the panel on Tasks. The island closes shortly after the line ends unless its report is open, and one result shows at a time.

**Wave rail** (`src/renderer/notch/VoiceRail.tsx`). While the panel is open, a small pill under the notch shows Listening, Thinking or Speaking with a few bars, which do not follow the real audio. It hides at idle.

## First run

**Keys.** Main reads `.env` once at start and removes every `*_API_KEY` name from `process.env` before any window opens. It passes the engine its keys as start parameters, and no key reaches the renderer. A missing Deepgram key holds the panel open with a line that points to the env file. The setup steps are in [README.md](../README.md#setup).

**Setup checklist.** On macOS, when Accessibility or the microphone is missing at launch, the panel opens by itself with a checklist in place of its normal contents. No file remembers setup, so each launch decides. Main rechecks each second while one is missing and starts the hold key on the Accessibility grant, with no restart. If that start throws, the row says to quit and run `npm start` again. The first hold after both are granted closes the checklist for good. Under `npm start`, macOS gives both permissions to the terminal app that ran the command, not to Electron, so the checklist says to switch on your terminal app.

## Folder map

- `src/index.ts`: main process entry. Keys, engine start, wiring, restart on an uncaught failure.
- `src/main/`: hold key, window, voice, speech, talker, setup. `platform.ts` holds the Mac and Windows differences.
- `src/main/tasks/`: the shown state. Task list and queue, decision check, routes, failure turns, Chat list, history.
- `src/engine/index.ts`: engine entry, the start function and the port.
- `src/engine/core/`: what every plug shares. Port, worker loop, dispatch, limits.
- `src/engine/plugs/research/`: the research plug. Web tool, URL rules, prompts, done check.
- `src/providers/`: Anthropic, Deepgram (Flux, Aura-2, Nova-3) and Exa calls.
- `src/shared/`: `ipc.ts` for renderer <-> main, `engine.ts` for main <-> engine, `cards.ts` for the types both carry.
- `src/preload.ts`: the `window.baymax` bridge.
- `src/renderer.ts`, `src/renderer/`: renderer entry, panel contents, setup checklist, microphone, playback.
- `src/renderer/notch/`: the shell around the notch. Shapes, motion, voice pill, ring, answer island, wave rail.
- `src/renderer/cards/`: task cards, report page, sources.
- `tests/`: tests and harnesses, at the same relative path as the code they cover.

## Not built yet

- The engine in its own process.
- Windows.
- Saving tasks and answers across restarts, and resuming after a crash.
- Memory of the user's taste, with consent.
- Several tasks at once, and deep research with a plan and many workers.
- Steering a running task, and live words on screen while you speak.
- More plugs, such as document creation, email and GitHub, with approvals for anything that acts outside.
- A Settings screen for your own keys.
- Opening the text box from any app, and closing the panel on a click outside it.
