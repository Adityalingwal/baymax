# Architecture — 25 Oct 2026

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
                                       +-> agent engine (own loop on the Anthropic SDK), in main
```

## Stack

| Part | Choice |
| --- | --- |
| STT | Deepgram Flux (swap: Cartesia Ink-2) |
| TTS | Deepgram Flux TTS (swap: ElevenLabs; Aura-2 if no Flux TTS access) |
| LLM, first test candidate | Claude Haiku 5.5 (thinking off, effort low) |
| LLM, second test candidate | GPT-6 Luna (reasoning none) |
| LLM, fallback candidate | Sonnet 5.5 (`between_tools`, effort low) |
| Keys | Our own keys for the demo, from `.env`, read only by the main process (the user's own keys and a Settings screen with `safeStorage` come later) |
| Agents | Our own agent loop on the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), run in the main process on an Anthropic API key |

- Provider changes are manual, after the adapter is validated. No automatic routing or failover.
- Baymax owns agent control: approval, stop, steer, and recovery from a local SQLite database that holds every step and the chat history. A runtime spike on macOS (25 Oct 2026) validated this on our own loop.
- Not in the first cut: the Claude Agent SDK (a later option for a coding worker) and the user's own Claude Code / Codex login (a later option).
- No framework: our own pipeline inside the app.

## Platform

- Electron, one codebase for macOS and Windows, all TypeScript.
- Main process = Node: adapters, LLM, agent engine, keys.
- Renderer = UI and mic.
- Hold-key via `uiohook-napi`: Option on macOS, Ctrl+Win on Windows.

## Folder map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Main process entry: window, hotkey wiring, IPC |
| `src/preload.ts` | Bridge between main and renderer |
| `src/shared/ipc.ts` | IPC channel names and payload types |
| `src/renderer.ts`, `src/renderer/` | UI (React) |
| `src/main/hotkey.ts` | Hold-key detection |
| `src/main/hold.ts` | Hold state from key events; pure |
| `src/main/platform.ts` | Platform flags and labels |
| `src/main/adapters/` (planned) | STT / TTS / LLM providers |
| `src/main/agent/` (planned) | Agent engine: loop, approval, stop, steer, SQLite recovery |
| `src/renderer/` (planned additions) | Mic capture and playback UI |
