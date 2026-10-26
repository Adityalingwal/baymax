# AGENTS.md

Baymax is a voice-first desktop assistant (Electron + TypeScript + React + Tailwind) for macOS in V1, Windows later. Setup is in `README.md`. Product and stack decisions are in `docs/architecture.md`.

## Areas

| Area | What it covers | Paths today | Works here |
| --- | --- | --- | --- |
| Main and engine | Electron main process (hold-key, windows, voice providers, speech) and the agent engine, which runs inside main behind a port in V1 | `src/index.ts`, `src/main/`, `src/engine/` (planned) | Aditya |
| UI | Renderer: window contents, visuals, mic | `src/renderer/`, `src/renderer.ts`, `src/index.html`, `src/index.css` | Somesh, Kashish |
| Shared contract | Contracts between the renderer, main and the engine: renderer <-> main (`src/shared/ipc.ts`), main <-> engine (`src/shared/engine.ts`), the types both carry, and provider code shared by main and the engine only | `src/preload.ts`, `src/shared/`, `src/providers/` (planned) | both sides |
| Build and config | Tooling and packaging | `package.json`, `forge.config.ts`, `webpack.*.ts`, `tsconfig.json`, `.eslintrc.json` | anyone, in its own small PR |

- Paths move as the code grows; the area is what counts. The current folder map is in `docs/architecture.md`.
- Work inside your area. When a change needs a file from another area, make it and name that file in the PR description.
- Read `docs/architecture.md` before changing the stack, a provider, the voice pipeline or the folder map. The architecture changes by an explicit decision, never silently by an agent: update `docs/architecture.md` first, then the code.

## Code

- Write plain functions and modules. Use a class only when a library requires one.
- Use `as const` objects and union types instead of `enum`.
- Write application code in TypeScript (`.ts`, `.tsx`). Keep it strict: no `any`, `@ts-ignore` or non-null `!`.
- Keep a file at 300 lines or fewer and a function at 50 or fewer. One file does one job.
- Name folders and functions by what they do (`adapters/`, `startListening`). Replace generic names such as `utils/`, `helpers/`, `Manager`, `handler`, `data` with specific ones.
- Use one word per concept: `hold`, `listening`, `idle`, `talker`, `coordinator`, `worker`, `plug`, `engine`, `task`, `card`, `done check`, `adapter`.
- When the same concept is written twice, move it to one place. Code that only looks similar stays separate.
- Delete exports, options and code that nothing calls.
- Await every promise or give it a `.catch`.
- Keep the main process responsive: use async file and process APIs (no `*Sync` calls anywhere in `src/`, the engine included, since it runs in main in V1), and no CPU-heavy work.
- When a provider (STT, LLM, TTS, agent model) fails, show or speak an error that names the cause and the fix. The app keeps running.
- Give a provider its key, client or `fetch` as a parameter so it can be tested offline. Add an interface only when a second real provider exists.
- Keep imports acyclic. Use named exports and explicit re-exports.

## Process boundaries

- The renderer talks to main only through `window.baymax` from `src/preload.ts`. It imports no `electron`, no Node modules, no main or engine files, no `src/shared/engine.ts` and no `src/providers/` code, and makes no network calls. It never talks to the engine.
- The engine imports nothing from `src/main/`, `src/renderer/` or `electron`. Main imports the engine only through `src/engine/index.ts` (its start function and port), and nothing from `src/renderer/`. Main and the engine talk only through the port, with plain JSON messages, so V2 can move the engine into its own process without changing either side. `src/providers/` (provider calls shared by main and the engine) imports nothing from either process folder.
- Main owns the shown app state (hold, listening, the task list and its cards). The engine owns the running task's state; V1 has no database. The renderer shows what main sends.
- Define channel names and payload types once per link: renderer <-> main in `src/shared/ipc.ts`, main <-> engine in `src/shared/engine.ts`; both sides of a link import them. Types both links carry live in a third shared file; link files never import each other.
- Mac/Windows differences live in `src/main/platform.ts`; main sends platform-specific labels to the renderer.
- Keep `contextIsolation: true` and `nodeIntegration: false`. `preload.ts` exposes narrow, typed functions; subscriptions return a cleanup function.
- API keys come from `.env` and are read only in main, which removes them from `process.env` before any window opens. Main passes the engine the keys it needs as start parameters. No key reaches the renderer.

## Comments and docs

- Comment only a non-obvious why (an OS quirk, a security reason), in one line. Keep `TODO` trails and brief or ticket references out of the code.
- Repository content is English: code, comments, docs, commits, PRs.
- `README.md` holds setup, scripts and current behavior. Update `docs/architecture.md` in the same PR that changes the stack or the folder map. Write each fact once and link to it.

## Tests

- Test logic and providers through their public interface. One behavior gets one test; variants go in one table-driven test.
- Fake only external things: network and providers, including the agent's model API. A person checks UI, hold-key and permission changes with `npm start`.
- Fix the code, not the test: keep tests and checks intact. After two failed repair attempts, stop and report the failure and what was tried.

## Git and PRs

- Branch from `main` as `name/task` (e.g. `somesh/listening-panel`). All changes reach `main` through a PR.
- One PR is one working step: its types, code and tests together, around 400 changed lines or fewer as a soft limit (generated files excluded). `main` runs after every PR. A ticket may take several PRs; each links its ticket.
- PR title: `type(scope): summary`, scope `ui`, `main`, `engine` or `shared` when one applies (e.g. `feat(ui): listening panel`). PR body: what changed, evidence (screenshot for UI, output for main or engine), shared files touched, what was not verified.
- One commit has one purpose and a one-line message. Merge with a merge commit, not squash, and only when CI is green.
- Each person reviews and merges their own PR. Before opening it, review the diff against the task and these rules, and get a review from a second model that did not write the code (e.g. Codex for Claude-written code).
- Agents may commit and push on their own task branch. Opening or merging a PR needs the instruction of the person you work for.

## Agent skills (mattpocock-skills)

- Issues live in this repo's GitHub Issues (`gh` CLI).
- Grilling: one question at a time, with your recommended answer.
- A skill's built-in commit, push or PR step follows "Git and PRs" above, not the skill.
- Implement from an implementation brief with a background agent, then follow the review rule in "Git and PRs". Skip `/implement`, `/implement-spec` and the plugin's `code-review`; use `tdd` only where the brief asks for it.
- Skip the plugin's `research` skill.
- Create `GLOSSARY.md` or `docs/adr/` only after the person you work for confirms the term or decision; product and stack decisions stay in `docs/architecture.md`.

## Agent guardrails

- Never read, print or commit `.env`, `.env.*` (except the placeholder-only `.env.example`) or any key or token.
- Never force-push, `git reset --hard` or `git clean -f`. Before editing, check `git status` and the existing diff; keep other people's uncommitted work.
- Ask the person you work for before adding a dependency, a top-level folder or a build/config change, and before anything that spends paid API or subscription quota.
- Run `npm start` only with a person present (it opens a window and may trigger OS permission prompts); background agents never run it.
- Verify unknown provider or CLI behavior with a small runtime check before building on it.
- When stuck, or when a decision looks wrong, stop and report. Do not guess or widen the scope.

## Done means

1. `npm run lint` has 0 errors.
2. `npm run package` passes. This is the type-check; standalone `tsc --noEmit` is broken with `@types/node`.
3. `npm test` passes.
4. The report shows the real output and lists what was not verified (e.g. Windows, live audio).

Prettier formats the code, the pre-commit hook runs ESLint and Prettier on staged files, and CI runs the checks on every PR.

ESLint (`.eslintrc.json`) enforces the Code and boundary rules above where a lint rule can; a new rule lands only after it is shown to fail on a bad example. Today it holds the renderer and main zones and a `*Sync` rule over all of `src/` (dropped for tests and configs); the engine zones come with the first build PR, and the `*Sync` rule stays over all of `src/`. Where a library requires a class, disable `no-restricted-syntax` on that line with a one-line reason.
