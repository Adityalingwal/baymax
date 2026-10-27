# Baymax

Voice-first personal AI assistant: hold one key, speak, and your work goes to the agent you choose.

Status: typed path (27 Oct 2026). Type a question in the window and Baymax researches it on the web: a card shows the start line, the progress, and then the checked answer with its sources. The hold-key still only shows *Listening…* and *Idle*; voice comes with #27.

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
