# Baymax

Voice-first personal AI assistant: hold one key, speak, and your work goes to the agent you choose.

Status: skeleton: hold-key only (23 Oct 2026). Today the app opens one small window that shows *Listening…* while you hold the key and *Idle* when you release it.

## Requirements

- Node 22 and npm
- macOS or Windows

## Setup

```bash
git clone https://github.com/Adityalingwal/baymax.git
cd baymax
npm install
npm start
```

First run on macOS: the hold-key needs Accessibility permission. Grant it in System Settings > Privacy & Security > Accessibility to the running app, then restart. During `npm start` macOS may list it as Electron; packaged builds show Baymax. The window has a button that opens that settings pane.

The hold-key is Option on macOS and Ctrl+Win on Windows.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Run the app in development |
| `npm run package` | Build the app into `out/` (this is also the type-check) |
| `npm run make` | Build installers (Squirrel on Windows, ZIP on macOS) |
| `npm run lint` | Run ESLint |

## How we work

- Branch from `main` as `name/task`, never commit to `main` directly.
- Keep PRs small; merge with a merge commit, not squash.
- `main` always runs: `npm install && npm start` must work.
- Never commit `.env` or any key. Copy `.env.example` for local dev.
- Folders: `src/main/` = core (Node), `src/main/adapters/` = STT/TTS, `src/renderer/` = UI. Owners: TBD.
- `package.json` and `src/index.ts` change only in coordination with Aditya.

Design decisions live in [docs/architecture.md](docs/architecture.md).

Team: Aditya, Somesh, Kashish, Nitesh.
