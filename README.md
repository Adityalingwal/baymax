# Baymax

Voice-first personal AI assistant: hold one key, speak, and your work goes to the agent you choose.

Status: streaming voice, the talker and the notch panel (31 Oct 2026). Hold the hold-key (Option on macOS), ask a question and release, or type it in the window. While the key is held the microphone streams to Deepgram Flux over a socket kept open from start; when that socket is down, the held clip goes to Deepgram's pre-recorded call instead. Spoken lines stream from a warm Deepgram Aura-2 socket and play as the audio arrives; when that socket is down, a line goes to the Aura-2 REST call. One Fable front call speaks first and then decides: it says a short line (the whole answer when it can give one, the one question when it needs a detail, or a line showing it understood the work), then calls a decide tool that picks the route (reply, ask, work, stop or retry) and, for work, gives a goal; main checks the decision in code before anything starts, and the worker reads that goal and the user's words. The worker never asks the user anything. The result's spoken line is said as given. Baymax researches the question on the web: a card in the panel's Tasks tab shows the latest progress line, and then the title and the worker's line, with the full report on its own page behind a button and the sources below it. A card appears only for work: replies, questions and failed front calls have none, and their words and lines go to the Chat tab. Saying stop cancels a task as its stop button does. When a task fails, its card stays with the cause, what it found and a Retry button, and Baymax says in its own words what went wrong and asks whether to try once more; that line goes to the Chat list. A yes, or Retry, runs the same task again. If no model can speak, the cause is said as written. Running work comes first, then finished tasks, the last to finish first. The top strip holds the Chat and Tasks tabs, a mute toggle and a close control that always closes the panel at once and keeps the field's text; the panel opens on the tab last open. The panel opens when the pointer rests on the notch and closes 300 ms after it leaves; with text in the field it closes after 3 s instead and keeps the text, each key typed outside restarts the 3 s, and the pointer coming back stops it. Esc in the field closes it and keeps the text. With the panel closed, a small pill on the notch shows Listening, Thinking or Speaking (with a mute button) and closes after speech ends. While tasks run, a small ring spins on the notch; a finished task's title and line show as a card under the notch while Baymax says the line, for 2 s after it while the pointer is off it. A button on a card with a report opens the report right there, and a click elsewhere on the card opens the Tasks tab. A second result waits until the first card has closed. A chat reply and a failed task show only the small pill.

## Requirements

- Node 22.22.1 or newer, Git 2.32 or newer, and npm
- macOS or Windows

## Setup

```bash
git clone https://github.com/Adityalingwal/baymax.git
cd baymax
npm install
npm start
```

Before `npm start`, copy `.env.example` to `.env` in the project root and fill in the keys. Only main reads it. Keys set only in the shell are not kept across an automatic restart, because main removes them from its environment.

First run on macOS: the hold-key needs Accessibility permission. Grant it in System Settings > Privacy & Security > Accessibility to the running app, then restart. During `npm start` macOS may list it as Electron; packaged builds show Baymax. The window has a button that opens that settings pane.

The hold-key is Option on macOS and Ctrl+Win on Windows.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Run the app in development |
| `npm run package` | Build the app into `out/` (this is also the type-check) |
| `npm run make` | Build installers (Squirrel on Windows, ZIP on macOS) |
| `npm run lint` | Run ESLint |
| `npm run format` | Format all files with Prettier |
| `npm run format:check` | Check that all files are formatted with Prettier |
| `npm test` | Run the unit tests with Vitest |

## How we work

Team rules for people and agents: [AGENTS.md](AGENTS.md). Design decisions: [docs/architecture.md](docs/architecture.md).

Team: Aditya, Somesh, Kashish, Nitesh.
