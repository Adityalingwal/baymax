# Baymax

Voice-first personal AI assistant: hold one key, speak, and your work goes to the agent you choose.

Status: streaming voice and the front call (29 Oct 2026). Hold the hold-key (Option on macOS), ask a question and release, or type it in the window. While the key is held the microphone streams to Deepgram Flux over a socket kept open from start; when that socket is down, the held clip goes to Deepgram's pre-recorded call instead. Spoken lines stream from a warm Deepgram Aura-2 socket and play as the audio arrives; when that socket is down, a line goes to the Aura-2 REST call. One Fable front call speaks first and then decides: it says a short line (the whole answer for small talk, the clarifying question when it asks one, or a line showing it understood a research question), then calls a decide tool that picks the route and, for research, gives a one-line goal; main checks the decision in code before anything starts, and a small brief-writer step in the engine turns the goal into the worker brief. The result's spoken line and the worker's next question are said as given. Baymax researches the question on the web: a card shows the latest progress line, and then the checked answer with its sources; a chat reply shows as a small card with only its text. Cards that need you come first, then running work, then results; the top strip shows a status line and a mute toggle. The panel opens when the pointer rests on the notch and closes 300 ms after it leaves (not while the field holds text); Esc in the field closes it and keeps the text. With the panel closed, a small pill on the notch shows Listening, Thinking or Speaking (with a mute button) and closes after speech ends.

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
