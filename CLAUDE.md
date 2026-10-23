# Baymax

Voice-first personal AI assistant (Electron + TypeScript). Read `README.md`, then `docs/architecture.md`, before changing anything.

## Rules

- TypeScript only. Electron main = Node (adapters, LLM, agent, keys). Renderer = UI + mic.
- Never read or print `.env` or any API key. Keys are the user's own.
- Never commit to `main`. Branch as `name/task` and open a PR (merge commit, not squash).
- Keep files small. Do not add new top-level folders without asking.
- English in code, docs, comments and commit messages.
- `package.json` and `src/index.ts` change only in coordination with Aditya.

## Checks

- `npm run package` is the type-check (`tsc --noEmit` is broken with `@types/node`).
- `npm run lint` must have 0 errors.
- Do not run `npm start` unattended: it opens a window and may trigger OS permission prompts.
