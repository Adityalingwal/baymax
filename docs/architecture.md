# Architecture — 23 Oct 2026

Decisions only. This is the target architecture; today the repo implements only the hold-key skeleton.

## What

One key plus speech: hold the key, speak, and the work goes to the user's chosen agent. The result appears on screen, with a short spoken reply. Small memory.

## First cut

In:
- One key + speech.
- Send work to the chosen agent; start a new agent from the same utterance.
- Spoken progress.
- Approve or steer without switching apps.
- Result on screen plus a short spoken reply.
- Small memory: the session, "should I remember this?", which agent is used for which kind of work.

Out:
- Connectors.
- Camera / live video.
- Long-term memory.
- Cost display.
- Explainers / diagrams.
- Phone calls.

## Pipeline

```
hold key -> mic (renderer) -> STT -> LLM -> TTS -> speaker
                                       |
                                       +-> agent CLI (claude -p / codex app-server), spawned from main
```

## Stack

| Part | Choice |
| --- | --- |
| STT | Deepgram Flux (swap: Cartesia Ink-2) |
| TTS | Deepgram Flux TTS (swap: ElevenLabs; Aura-2 if no Flux TTS access) |
| LLM, first test candidate | Claude Haiku 5.5 (thinking off, effort low) |
| LLM, second test candidate | GPT-6 Luna (reasoning none) |
| LLM, fallback candidate | Sonnet 5.5 (`between_tools`, effort low) |
| Keys | The user's own, from `.env`, read only by the main process (a Settings screen with `safeStorage` comes later) |
| Agents | The user's own Claude Code / Codex login, run as a CLI process (`claude -p`, `codex app-server`) |

- Provider changes are manual, after the adapter is validated. No automatic routing or failover.
- Agent approval and stop integration is pending runtime validation.
- On Windows, stop goes through the control protocol, not SIGINT.
- No framework: our own pipeline inside the app.

## Platform

- Electron, one codebase for macOS and Windows, all TypeScript.
- Main process = Node: adapters, LLM, agent processes, keys.
- Renderer = UI and mic.
- Hold-key via `uiohook-napi`: Option on macOS, Ctrl+Win on Windows.

## Folder map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Main process entry: window, hotkey wiring, IPC |
| `src/preload.ts` | Bridge between main and renderer |
| `src/renderer.ts`, `src/renderer/` | UI (React) |
| `src/main/hotkey.ts` | Hold-key detection |
| `src/main/platform.ts` | Platform flags and labels |
| `src/main/adapters/` (planned) | STT / TTS / LLM providers |
| `src/main/agent/` (planned) | Agent CLI processes |
| `src/renderer/` (planned additions) | Mic capture and playback UI |
