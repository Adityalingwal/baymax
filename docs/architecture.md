# Architecture — 26 Oct 2026

Decisions only. The design is split into four parts:

- **V1**, built now for the 31 Oct buildathon demo and the YC application ([V1 design](#v1-design)).
- **V1 if time remains**, built only after V1 works end to end ([list](#v1-if-time-remains)).
- **V2**, built later; its design is kept in [V2 design](#v2-design) so V1 can grow into it.
- **Out of Scope**, not planned now; any item can come back by an explicit decision ([list](#out-of-scope)).

Today the repo implements only the hold-key skeleton (`README.md`). Timings, counts and limits are starting values, tuned at build ([Starting values](#starting-values)).

**Rule for every cut.** V1 picks the option that is easiest to build and to reason about, with the fewest special cases. It keeps the seams the design names (task ids, goal versions, parent task ids, worker briefs, result events) and stable contracts (the engine port messages, the display state, the brief and result shapes), so a V2 part is added by extending them; internals behind those contracts may change.

## What

Press a key and ask; Baymax searches the web in the background while the user keeps working in their own app, and brings the answer onto the same screen. Baymax is its own on-screen layer that works over any app; it is not a feature inside another app.

The V1 journey:

1. The user is working in any app and wants to know something.
2. They hold the Baymax key and speak, or type into Baymax's text box.
3. If important information is missing, Baymax asks one clarifying question.
4. Baymax searches in the background while the user keeps working.
5. The answer appears on the same screen as a text card, and Baymax speaks a short line unless muted.
6. If the answer is not enough, the user asks a follow-up that keeps the earlier context.

Asking by voice and receiving an answer never take the focus away from the user's app; deliberately clicking or typing in Baymax may.

**Information first.** V1 searches, reads and explains; the user decides what to do next. It takes no action outside (no email, no file edits, no GitHub issues). "Result arrived" is not "result correct": a task is done only when it passes the [done check](#done-check).

**Wider direction**, for the pitch and V2: information reaching people wherever they are, Baymax learning the user's taste, and an agent that also does tasks end to end. V1 proves the information part on a Mac.

## Scope

### V1

- macOS only, English only, our own API keys from `.env`.
- Ask by holding Option and speaking, or by typing into the text box in the Baymax window. The build is text-first: the first slice is typed question -> intake -> worker -> done check -> card, and voice is wired in when it works.
- One task runs at a time; new tasks queue. One worker per task, no coordinator model.
- One research profile: the worker decides how much to search.
- Answers live in memory while the app is open; no database, no crash resume.
- The engine runs inside the main process behind a port.
- Cancel from the screen; speech silenced by the key or the mute switch.
- Friendly fixed failure lines; raw errors only in the dev log.

### V1 if time remains

- Finished answers saved to a JSON file, so they survive a restart: serialized writes to a temporary file renamed in one step, a schema version, a failed save leaving the answer on screen marked unsaved, a malformed file never blocking start-up.
- The worker's todo list (an `update_todo` tool: done, in progress, left), shown on the task card.
- Firecrawl for JavaScript-only pages and PDFs, PDF page caps, and the full web live test ([Checks](#checks)).
- Typed input from any app: Option + Space opens the text box over the user's app and returns focus when it closes (not a double tap on Option, which would clash with holding it).

### V2

Each item's design is in [V2 design](#v2-design).

- Several tasks at once, each with its own coordinator; splitting a task across parallel workers with one writer.
- Deep research with a plan, many workers and a report file.
- The talker model and streaming voice; the speech queue, "go on" and "what did I miss".
- Voice stop with its three scopes; steering a running task; goal versions above 1.
- Actions outside with approvals, the uncertain-action card and rollback; the next plugs (document creation the candidate first; email, GitHub, connectors such as Gmail and Calendar).
- The full UI contract and the full step log.
- SQLite, crash resume and the engine as its own `utilityProcess`.
- The cost reservation ledger and our own retry owner.
- Compaction.
- Memory: learning the user's taste, with consent.
- Jev picking the worker's model; Windows; the user's own keys with a Settings screen and `safeStorage`; model-written progress summaries.
- Later candidates to investigate, not committed: the user's own Claude Code or Codex login (Conductor-style route); the Claude Agent SDK as a coding worker.

### Out of Scope

Not planned now, not "never".

- Phones, other devices and other apps such as Instagram or WhatsApp.
- Languages other than English, Hindi and Hinglish included.
- Open-mic (always listening); speech-to-speech models (OpenAI Realtime, Gemini Live) and managed voice agents (Deepgram Voice Agent, ElevenLabs Agents).
- Cloud agents on VMs (Manus or Devin style) and a process per worker.
- OpenRouter and model providers other than Anthropic.
- Showing cost to the user.
- Social data APIs (X, Reddit, LinkedIn), fetching x.com or linkedin.com pages, other search providers (Perplexity, Brave, Jina, Parallel, Gemini) and a separate deep-research mode on Perplexity or Gemini.
- Camera and live video, explainers and diagrams, phone calls.

## V1 design

### Pipeline

```
renderer                         main                                   engine (in main, behind the port)
text box   --IPC-->  ------------------------------------------+
mic clip   --IPC-->  Deepgram pre-recorded STT -> transcript --+--> intake check -> worker -> done check
playback   <--IPC--  Deepgram REST speech <- speak()           <--- start line, progress, result, failure
cards      <--IPC--  whole display state                       <--- task events
```

- Typed text and a final transcript enter the same route: the [intake check](#intake-and-tasks).
- Nothing acts before the full final sentence after key release.

### Stack

| Part | Choice |
| --- | --- |
| STT | Deepgram pre-recorded transcription of the held clip, one call per utterance |
| TTS | Deepgram REST speech, one call per line, one voice |
| Intake check | Claude Sonnet 5.5 (Haiku 5.5 if the first spoken line is too slow) |
| Worker | Claude Sonnet 5.5, picked in code by `pickWorkerModel`, the seam Jev plugs into later |
| Done check judge | Claude Sonnet 5.5 |
| Web | One `web` tool owned by Baymax: a search provider (Exa or Tavily) and plain page reads |
| Agent runtime | Our own loop on the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), in the engine |
| Storage | Memory only |
| Keys | Our own keys from `.env`, read only in main |

- Claude only. Each role's model is one field; the models are measured in build week.
- No framework: our own pipeline and agent loop inside the app.

### Processes and the port

| Process | Runs | Owns |
| --- | --- | --- |
| Main | Hold-key, windows, IPC with the renderer, the Deepgram calls, `speak()`, the engine behind its port | The shown state: the task list, its cards and the queue |
| Engine (inside main in V1) | Intake check, worker, done check, limits, the worker model pick | The running task's state |
| Renderer | Text box, cards, mic recording, playback | Nothing; it shows what main sends |

- **The port.** The engine code lives in `src/engine/` and imports nothing from `src/main/`, the renderer or `electron`. It builds its own providers from `src/providers/`; its start takes only serializable values (keys, paths, settings), and test fakes enter through a separate optional parameter. Main and the engine talk only through one port object (`send`, `onMessage`, `close`) carrying plain JSON messages with ids, typed in `src/shared/engine.ts`. Cancel is a port message (`{ type: "cancel", taskId }`) that the engine maps to its own `AbortController`. V1 implements the port in-process; V2 swaps in a `utilityProcess` behind the same port.
- **Why in main.** The reasons for a separate process (synchronous SQLite, crash resume, restart) are V2, the agent loop mostly waits on the network, the spike ran the loop inside main, and a separate process was never tested on this repo's Electron 40.
- **The risk and its limits.** Engine code that blocks would also freeze voice and cancel. V1 lowers this without guaranteeing against it: no `*Sync` calls anywhere in `src/`; every model and web call has an `AbortSignal` and a deadline; downloads are capped before parsing, and PDFs and JavaScript pages are not read; history and kept page text are bounded. Expected network, model and parsing failures are caught at their awaited task boundaries and end the task with a [failure line](#failures-the-user-hears). A truly uncaught exception or unhandled rejection is not attributed to a task and normal work is not resumed, because Node's state may be undefined: main logs it, shows "Baymax hit a problem and is restarting." and relaunches the app (`app.relaunch()`, then exit). Only a separate process (V2) can stop a truly stuck engine.
- **Keys.** Main reads `.env` once at start and deletes the keys from `process.env` before any window opens. The renderer gets no key and makes no network calls; the display state carries display fields only.
- One app instance: Electron's single-instance lock makes a second instance focus the first and exit.

### Voice

- **Listening.** The renderer records the microphone (`getUserMedia`) while Option is held and hands the clip to main over typed IPC at key release; it also plays speech (Web Audio), because Chrome's echo canceller only removes audio Chrome itself plays (Electron issue #47043). Main sends the clip once to Deepgram's pre-recorded transcription. A hold longer than the cap is ended by code as a key-up. If the transcript fails or comes back empty, Baymax says "I didn't catch that, say it again."; a late transcript for an old utterance is dropped.
- **Why single calls.** V1 reads nothing before key release and does not continue a cut line, so a live stream (reconnects, end-of-turn signals, keep-alive) adds about a day for little gain. The cost is about one second more before the transcript and no live words on screen while speaking.
- **Speaking.** Baymax speaks in four places only, and everything spoken is also on the screen: the clarifying question, the start line ("Okay, looking at how Hermes works."), a one- or two-line answer with the rest on the card, and a failure line. A queued task folds into the start line ("Okay, I'll look at that after the current one.").
- **One playback owner.** All speech goes through one `speak(line, kind)` function in main. Each line carries its task id; one line plays at a time and a new line waits for it; the fixed "Let me check." is dropped if the start line is ready first; a line for a cancelled or replaced task is dropped. A key press, mute or cancel clears the pending lines as well as the one playing. Nothing is spoken while the key is held, and pressing the key while Baymax speaks silences it at once.
- **Mute.** A switch turns speech off so everything shows on the screen only.
- **Voice down.** When Deepgram is unreachable, Baymax says on screen that voice is unavailable and points to the text box; earlier answers, cancel and card clicks keep working.

### Intake and tasks

- **The intake check** is one structured Sonnet 5.5 call, its say-back line first in the output. It gets the user's exact words, a short code-kept record of the recent questions and answers, and the waiting clarifying question if any. It decides whether the words are a new question, the answer to the waiting question or a follow-up; whether a clarifying question is needed (only when missing intent, constraints or the thing referred to would change the work); the start line; and the worker brief. If the start line is not ready about 1.5 seconds after the final transcript, code speaks a fixed "Let me check."
- **Outside research.** A request for anything but research is said back as "I can't do that yet in this version.", and no task starts.
- **The say-back** names what Baymax understood ("how Hermes works inside, from its docs and code"). It is feedback, not a gate: the work starts at once, and a wrong say-back is fixed by cancelling the card and asking again.
- **Tasks and the queue.** Main keeps one list of tasks, each with an id and a state: thinking, clarifying, queued, running, done, incomplete or cancelled. A "thinking" card appears at key release (or on submit) before the intake returns, and its id becomes the task's id. The runner starts the next queued task when none runs. Each task carries a goal version (always 1 in V1) and a depth value (always "normal" in V1).
- **Clarifying questions.** At most one waits at a time. It has two to four choices, the first marked recommended, plus "something else", and is answered by voice, typing or click, bound to the question's id. One answer per id; a second click or a late answer is ignored; a spoken answer binds to the question shown when the key went down. While it waits, words that clearly do not answer it go through the intake as a new question and are queued; the question stays pending.
- **Follow-ups.** Each answer is stored under its task id. A follow-up gets a `parentTaskId`, and its brief carries the parent's answer, its source references and its open points; an unrelated question starts without a parent. A follow-up queued before its parent finishes keeps the parent reference and gets the parent's final result when it starts; if the parent ended incomplete or cancelled, the start line says so and the follow-up uses what the parent found, labelled partial, or asks one question when nothing usable exists. It never runs as if a finished parent answer existed.
- **No steering.** Anything said while a task runs goes through the intake and is queued as a follow-up or a new question.

### Worker and research

- **The brief.** The intake writes it in four parts (the goal, the result shape, the tools or sources, the limits) plus the user's exact words, because a restated goal can lose a nuance ("an office laptop, not gaming"). The worker gets only the web tool and never the whole conversation. Text in a page is never an instruction to it.
- **One profile.** The worker decides while it works how much to search: a simple question ("today's weather in Delhi") stops after one or two searches, a bigger one ("how does Hermes work inside") reads six to eight pages, within one set of [limits](#limits-and-cost). This is checked on the first integrated path with a simple current fact and a moderately detailed product question (time to a useful answer, needless searches, source support, the incomplete outcome at a limit); if the worker over-searches or is too slow, the intake's quick or normal choice comes back through the depth value.
- **The answer.** The worker writes the answer itself and cites source ids; there is no separate writer. A near match is never called a full match: with no exact match it names the closest alternatives and the unmet constraints. An ambiguity that needs the user ends the task incomplete with one focused next question on the card.
- **Prompt cache.** The prompt start (instructions and tool list) stays fixed during a run.
- **Incomplete.** Baymax never calls a short result done. The card shows what was found and one line on what is missing, with one of three kinds: limit hit, sources thin, or a tool or provider error. A cancel by the user is "cancelled", not incomplete.

### Done check

It checks support and completion, not truth.

- The web tool keeps every page it read in code: source id, URL and capped text. The worker's answer cites those ids.
- **Code check first:** an answer exists, it cites sources, and every cited id is a page that was really read; an id from a search snippet only cannot pass.
- **Then the judge** gets the intake's goal, constraints and expected result, the answer and the code-kept excerpts. It checks that the answer meets the goal and that the important claims are backed by a page; a well-supported answer to the wrong question fails. The judge fetches nothing itself.
- If the check fails, the worker gets one more round. If it still fails, or the judge itself fails, the task ends incomplete with the unchecked part named, never done.
- Baymax closes a task itself once the check passes and the result is shown.

### Web tool

- Searches and page reads need no approval; the task's limits and cancel hold them in check.
- A page is read plainly with HTML-to-text. A JavaScript-only page or a PDF counts as no usable text, and the worker moves on.
- **Safety.** Only http and https. Only public destinations: the address the HTTP client actually connects to is checked at connection time (its own DNS lookup, IPv4 and IPv6), on every redirect and every retry, so localhost, `.local`, private and link-local ranges are refused even when a public-looking name resolves to them. If that cannot be built and verified in V1, the reader route is narrowed rather than the gap called harmless. x.com and linkedin.com are refused. No cookies or credentials are forwarded. Download size and time are capped before parsing. A hosted reader is used only if it keeps the same rules.
- **Page text is untrusted** for both the worker and the judge. The worker cannot act outside, but an injected page could still skew an answer or steer later searches and fetches, so page text never changes the instructions or the tool list. Offline tests cover injected instructions, private addresses (including a name that resolves to one) and redirects.
- X, Reddit and LinkedIn appear only as links and snippets from a normal search, and Baymax says it did not read the full thread.

### Cancel

- Cancel is a screen control: the user hovers a task's card or agent icon and clicks cancel. Main serves it in code, so it works when no model or Deepgram is reachable. There is no spoken "stop" in V1.
- It covers the whole task: its intake call, its waiting question, its worker, the judge, the retry round and its speech. It blocks every later step and every late result, and nothing starts on its own afterwards.
- The card shows "cancelling", then "cancelled" only after the loop has really ended. A request already sent may still finish and be billed.
- Each queued card has its own cancel; cancelling one task leaves the others.

### Screen and cards

- Main sends the screen its whole display state each time something changes, never keys, clients, prompts or raw provider objects. A window that subscribes or reloads gets the current state at once.
- All changes go through one state-update path in main, which drops a late callback from a cancelled or finished step before it can publish.
- **Cards:** the task card (with its state), the clarifying question card and the result card (the answer and its sources). Answers render as plain text or sanitized Markdown without remote embeds; a source link opens through one typed main action. How the cards look and where they sit is the UI team's call.
- **Progress** is minimal: the task card shows the latest step as a line built by code from the tool's own arguments ("searching: how Hermes works", "reading github.com"), never from page text, plus a small count such as sources read. The engine emits these as small structured progress events.

### Limits and cost

- Each task has limits on model calls, searches, active time and dollars ([Starting values](#starting-values)). At a limit the task ends incomplete, limit hit, and shows what it found.
- Every paid call (intake, worker, judge, the retry round, paid web calls) goes through one dispatch function that checks the limits before sending, sets an output-token ceiling per role, and writes usage and dollar cost to the dev log for the team. The user never sees cost. Without a reservation ledger the dollar limit is a conservative estimate, not an exact guarantee.
- Retries use the Anthropic SDK's own retry with a small `maxRetries` and an explicit timeout on every call. That it may resend a request after a timeout is an accepted V1 cost.

### Failures the user hears

- Failures are told to the end user, not to a developer: a plain, fixed line written in code that says what is not working and what to do, shown on the card and spoken unless muted. Error codes and provider messages go only to the dev log. A failing provider never closes the app.
- `{task}` is filled from the say-back in a short form.

| Failure | Line |
| --- | --- |
| Words not caught | "I didn't catch that, say it again." |
| Voice unavailable | "Voice isn't working right now. You can type your question instead." |
| Models unreachable | "I can't reach my models right now. Try again in a few minutes." |
| Search not working | "Search isn't working right now. Try again in a few minutes." |
| Model key rejected / no credit | "Baymax's model service rejected its key." / "Baymax's model service has no credit left." |
| Request outside research | "I can't do that yet in this version." |
| Limit hit / sources thin / error | "{task} reached its limit; here is what I found." / "{task} found little on the web; here is what I found." / "{task} hit an error; here is what I found." |
| Done check failed | "{task} is finished, but I couldn't check all of it; the unchecked part is marked." |
| Uncaught failure | "Baymax hit a problem and is restarting." |

"Here is what I found" is said only when findings exist; otherwise the line ends "before it found anything". The exact lines are tuned by ear once the voice is heard live.

### Platform

- Electron 40.2.1 (Node 24.11.1), all TypeScript. macOS only.
- Hold-key via `uiohook-napi`: Option on macOS, which needs the Accessibility permission. Mic: `NSMicrophoneUsageDescription` and the audio-input entitlement.
- The Baymax window shows over the user's app without taking keyboard focus when a voice question is asked or an answer arrives.

### Starting values

| What | Starting value |
| --- | --- |
| Longest hold | about 90 s |
| Fixed "Let me check." after the final transcript | about 1.5 s |
| First spoken line, target | under about 3 s; above it, the intake moves to Haiku 5.5 |
| Searches per task | about 8 |
| Active time per task | about 2 minutes |
| Model calls per task | about 15 |
| Dollars per task | about 15 cents |
| Done check retry rounds | 1 |
| Output-token ceilings | intake 1,024, worker 2,048 per step, judge 1,024 |

### Checks

Run before the code that depends on them:

1. The Anthropic SDK's retry and timeout defaults and its error causes for a dropped connection.
2. What Electron 40's main process does on an uncaught exception and an unhandled rejection.
3. Which Deepgram models the team key reaches for pre-recorded transcription and REST speech.
4. The search provider (Exa or Tavily) on the demo question, in the web tool's first PR.

In build week: the time to the first spoken line; mic timing and the held-clip transcript; the one-profile measurement above.

### Folder map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Main process entry: window, hotkey wiring, IPC |
| `src/preload.ts` | Bridge between main and renderer (`window.baymax`) |
| `src/renderer.ts`, `src/renderer/` | The screen (React): text box, cards, mic recording, playback |
| `src/main/` | Main process: hold-key, windows, Deepgram calls, `speak()`, the task list and shown state, the engine behind its port |
| `src/main/hotkey.ts` | Hold-key detection |
| `src/main/hold.ts` | Hold state from key events; pure |
| `src/main/platform.ts` | Platform flags and labels |
| `src/engine/index.ts` (planned) | Engine entry: the start function and the port; wires in the plugs |
| `src/engine/core/` (planned) | What every plug shares: the task runner, the intake, the worker loop, the done check, the dispatch function and limits |
| `src/engine/plugs/research/` (planned) | The research plug: the web tool, its prompts and its done condition |
| `src/engine/plugs/index.ts` (planned) | The one list of plugs, as explicit re-exports |
| `src/shared/ipc.ts` | Renderer <-> main channel names and payload types |
| `src/shared/engine.ts` (planned) | Main <-> engine port message types |
| `src/shared/` third file (planned, named by what it holds, for example `cards.ts`) | Types both links carry: a card, a task state |
| `src/providers/` (planned) | Process-neutral provider code: the Anthropic call with its timeout and usage record, the Deepgram calls. Imports nothing from a process folder |

- A plug is its tools, its prompts and its done condition; a new kind of work adds a plug folder and leaves the core alone. No `Plug` interface until a second plug exists. The core imports no concrete plug; only the engine entry wires in `plugs/index.ts`.
- `src/engine/` imports nothing from `src/main/`, `src/renderer/` or `electron`. `src/main/` imports the engine only through `src/engine/index.ts`. The renderer never imports `src/shared/engine.ts` or the engine.
- `src/shared/` holds only process-neutral contracts. A link file (`ipc.ts`, `engine.ts`) imports the shared type files; link files never import each other.

Config changes in the first build PR (asked first):

- `tsconfig.json` `target` to `ES2022` and TypeScript to 5.x, because TypeScript 4.5.5 with `target: ES6` cannot compile the `for await` streaming loop; checked against the SDK's minimum TypeScript, `@typescript-eslint` and `fork-ts-checker`.
- `.eslintrc.json`: extend the `import/no-restricted-paths` zones (the engine never imports main, the renderer or `electron`; main imports the engine only through its entry; the renderer never imports `src/shared/engine.ts`; `src/providers/` imports no process folder); keep the `*Sync` rule over all of `src/`; add `src/engine/index.ts` to `ignoreExports`; give `src/engine/**` an override with `env.browser: false`; show each changed rule failing on a bad example.
- Dependencies: `@anthropic-ai/sdk`, the Deepgram client (or plain `fetch`), the search provider client; `.env.example` gains their key names.
- CI moves from `windows-latest` to `macos-latest`.

### Set at build

- The exact message shapes in `src/shared/ipc.ts` and `src/shared/engine.ts`; the files inside `src/engine/core/` beyond this map.
- Prompts, including the intake's (how much of the recent record it sees).
- Result details: card layout, how many sources show, spoken length.
- How many tasks may queue; when a done or cancelled card leaves the screen.
- Each tool's abort time.
- The fixed spoken lines, tuned by ear.

## V2 design

Kept from the 26 Oct design freeze so V1 can grow into it. Each part says what it adds to V1; facts already in [V1 design](#v1-design) are not repeated.

### Several tasks and the coordinator

- **One coordinator per task**: its own Sonnet 5.5 conversation, between the intake check and the workers. It starts with the task and ends after the done check or a stop; it wakes for a user message for that task or a worker's question, result, incomplete or death, and sleeps at no cost between calls. The user still sees one Baymax.
- At most 3 active tasks; a fourth is queued and the user told. V1's task list and per-task state, cancel and limits make this a raised limit.
- **The intake check** additionally settles which task the words belong to (a new task, possibly with a parent; a follow-up or steer of a running task; a reopen of a finished one) and the research depth. A card under the pointer or the held key fixes the target before any model is asked. A first intake call has its own request id and belongs to no task; a clarifying question with no task yet creates the task in a "clarifying" state, and the second intake call is a continuation that carries the task and question ids, never creates another task, and on failure shows a retryable failure on that card.
- **What a coordinator keeps**: the user's words for the task, the goal and check list, the workers' reports and the user's mid-run messages. A new task inherits from its parent only the result, the goal line and the short conversation record, and can ask for an earlier task's full log.
- **Goal and check list**: every task starts with a short goal and check list (the expected result, the constraints that matter, how done is verified), from the deep plan or the say-back, and follows the new goal version after a steer.
- **Preferences**: today's audience or purpose is never inferred from past tasks, and what the user supplied this time is not asked again.

### Workers, splitting and the writer

- **Splitting**: the coordinator splits a task into sub-questions, one worker each, within the parallel-worker limit (normal up to 3, deep up to 5), grouping them or running bounded waves. Reaching that limit is not a failure.
- **Messages carried by the engine**: the brief (coordinator to worker, once); a question, asked while the worker stays alive (worker to coordinator, which answers from the user's words or the goal, or asks the user and passes back the bound answer); a steer or stop (under queue / send now and the goal version); the result (done with notes and evidence, or incomplete with its kind and reason). Progress goes from the worker's code to the screen, not through the coordinator.
- **One writer**: workers return notes and evidence records, not finished text; one writer writes the result from all notes (Opus 5.5 for a deep report). The coordinator never merges text; it runs the done check on the written result.
- **Continue**: missing evidence goes back as a bounded brief to that item's worker, a writing fault to the writer, and the revised result is checked again under the current goal version and remaining limits (2 rounds per task). A note made for an old goal version is caught before the writer sees it.
- **Budget split**: a reserve (about 40 percent of a deep task's dollar limit) is kept for the coordinator, writer and done check; the rest is split among workers through their briefs, and a worker's unused share returns when it ends. A worker that uses up its share ends with what it saved and returns incomplete; the coordinator decides once.
- **Worker death** in a living engine: screen only; its line shows "ended unexpectedly"; the coordinator restarts it once from its saved notes or ends the task incomplete, error kind. One spoken line per task outcome, never per worker.

### Deep research

- Depths: quick (one or two searches, a direct answer, Haiku 5.5), normal (moderate search, Sonnet 5.5) and deep (a full run with a cited report). The intake chooses from the meaning of the request, the say-back names it, the user changes it in a word.
- Deep first shows a plan made by Opus 5.5 and waits for "go" or a change. An explicit "go ahead directly" skips the wait: the plan is still made and used as the check list, the skipped wait is never recorded as approval, and missing-intent questions are not skipped. "Stop" while a plan waits stops the task before any worker starts.
- The report is UTF-8 Markdown in an app-owned reports folder under Electron's user-data path, named by task id and goal version, never overwritten, written to a temporary file and renamed; main records the artifact id and the renderer opens it through one typed main action. A deep result is a two-line spoken summary and a card that opens the report.
- Opus 5.5 versus Fable 5.1 on one report; Fable only if clearly better and inside the cost target (about 50 cents a deep task).
- Starting limits: deep up to 5 workers, about 60 model calls, 30 searches, 20 minutes, about 75 cents.

### Talker and streaming voice

- **Talker**: Claude Haiku 5.5 in main, between speech-to-text and the intake check. It gives the quick spoken line when the intake's line is not ready within about 3 s and labels what the user said: yes, no (with the reason), stop, answer (with the chosen option or the "something else" text), go on, progress, correction, new task, unclear. Code binds the first six; the rest go to the intake check. The talker never decides what a task means; on a failed label call it retries once on Sonnet 5.5.
- **Streaming voice**: Deepgram Flux STT over a WebSocket (16 kHz PCM frames from an AudioWorklet), live words on screen, reconnect, `ForceEndTurn` after the remaining frames on key-up, and a warm mic with about 0.3 s of pre-key audio if measuring shows the first word is lost. Flux TTS (swap: ElevenLabs) with Ping keep-alive and `Interrupt` carrying the session-wide playback offset, which is how `text_spoken` is known. With Aura-2 only, a notice counts as heard on the renderer's playback-finished report alone and is replayed whole after an interruption.

### Speech queue

- One speech queue in main, in this order: (1) approval or question, (2) stuck or failed, (3) done, (4) progress (screen only unless asked). V1's `speak()` becomes this queue. Several waiting notices become one line ("two tasks done, one needs your OK"); a new notice never interrupts a line being spoken; an approval or failure during speech gives a short sound and is spoken after.
- **Key press while speaking**: the next words decide a correction (answered knowing how much was heard from `text_spoken`), a new task or "go on", which continues from the cut word.
- **"What did I miss"**: main holds one notice list; Baymax speaks the notices not yet heard or opened (heard = played to the end without a key cut; opened = its card opened), or says nothing is new and offers the last few.
- **"How far along?"** is answered by code from the state, the goal version and the counts, never as a percentage. Later: a read-only helper model that reads the log.

### Controls: voice stop and steering

- **Stop has three scopes**: this reply, this task, everything. A plain "stop": if Baymax is speaking it silences the speech; otherwise it stops the latest task; "stop everything" stops all. Code catches the complete final utterance "stop" or "stop everything" with no model call and consumes its utterance id. Voice commands call V1's cancel function.
- **States**: received, stopping, stopped; "stopped" is never claimed without evidence that the work ended. A stop by the user and a stop by the system (timer, limit, crash, forced end) are recorded apart.
- **Messages to a working task**: queue (read at the next safe point; a newer queued instruction supersedes older ones), send now (the reply in progress is cancelled, its partial text kept, the user's message added; a running tool finishes first), or stop.
- **Goal versions**: a steer raises the version, which is checked before each consequential action and before the writer sees a note; old approvals become void. "Applied" is shown only once work follows the new instruction. At dispatch the engine claims the item's binding atomically and re-checks the stop and the goal version.
- **Reopen**: a later "this is wrong" reopens a finished task and continues its conversation.

### Approvals and actions

- **Authority**: only the user grants it. Text from a page, a memory entry or another agent's report is never an approval. A request to draft is not permission to send.
- **What needs approval**: only tools that act outside (send, delete, pay). Each tool declares where it runs, what effects it may have, where approval can really stop it, and whether it can be cancelled. Rollback of the user's files (copy before change) comes with the first plug that edits them.
- **Binding**: an approval is bound to the run, the tool call, its final arguments and the goal label; one answer per item; a changed request voids it. Approvals are asked one at a time through the speech queue; a bare "yes" approves only an approval the user sees in full. The card offers "allow once" and "no"; a lasting rule would be memory, which asks first. A pending approval has no time limit, and the waiting agent makes no model calls.
- **A "no" is information**: the reason goes to the agent for the rest of the task; it never reaches a refused result by another route; after several refusals in a row it asks what the user wants.
- **Uncertain action** ("may have happened"): "It happened" marks the step done; "Leave it" marks it not done; "Do it again" is a new approval for a live agent under the current goal version.
- The approval ledger and binding can be built from the spike controller and tested offline with a fake tool before the first plug that acts outside.

### Full UI contract and step log

- **Received, then applied**: every user action shows two steps and its card stays until a final outcome; an action can also end refused, superseded, failed or uncertain.
- **Ids and refusal**: every card, pending item and action has its own id; a stale id or a second answer is refused with its reason shown (question changed, already answered, agent stopped, goal changed); a repeat of the same action id gets the first outcome back.
- **Snapshot plus numbered updates**: one ordered, numbered update stream; a subscribing window gets a snapshot carrying its number, drops updates at or below it, and asks for a new snapshot on a gap.
- **Cards**: one status card per task with its workers as lines inside; one asking card in full at a time, the others in an "Also waiting" row, naming the agent and task from core's record; the deep plan card; replaced answers faded and labelled "replaced".
- **Card-targeted voice**: the renderer reports the card under the pointer; main takes the latest at key-down; words to a card go to that task.
- **Full step log**: opened from a card, paged most recent first, live while open; progress combined per agent at most once per second; an update from an older run or goal version is dropped.

### Persistence, recovery and the separate engine

- **SQLite** through Node's built-in `node:sqlite` (or a package, asked first), opened only by the engine. Every step and the chat history are saved; conversation storage stays apart from execution.
- **Save before acting**: a tool-call step and its state are written before the tool runs; each step's writes are one transaction; dispatch intent and the cost reservation are journaled before every paid request.
- **Crash resume**: a paid call or a tool with effects whose outcome is unknown is shown as uncertain and never repeated by itself; a read-only step is re-run; committed results are restored without repeating calls; after 3 crashes in a row a task is stopped and the user told.
- **The engine as a `utilityProcess`**, swapped in behind V1's port: started with `utilityProcess.fork`, keys passed through an explicit `env`, the database path and results folder as fork arguments, `execArgv: ["--no-warnings"]`, a second webpack entry (`entry: { index, engine }` with `output.filename: "[name].js"`), the engine allowed `DatabaseSync` by a lint override. It holds a database lock the OS releases on exit; a second engine refuses to open the database.
- **Lifecycle**: ready after recovery and state restore (about 20 s); a heartbeat about every 5 s with one probe after 3 missed beats, paused across machine sleep; a forced end (ask, wait, kill) when "stopping" does not come in about 3 s, recorded as a stop, not a crash; at most 5 restarts in about 5 minutes; main's messages to the engine carry ids and are acknowledged once saved.
- **Storage failure**: a failed save is retried once only for busy or locked; a persistent error pauses new paid and tool steps; a real corruption code offers "start fresh" (old file renamed aside) or "keep and fix later".
- **Machine sleep**: in-flight model calls count as provider errors, a paid web call is not retried, task clocks exclude the sleep.
- Runtime checks before this is built: `node:sqlite` inside a `utilityProcess` and its lock on crash and kill; stop time over the message channel; the engine ending when main is killed; forking from the packaged app with asar and fuses on.

### Cost ledger and retry owner

- **Ledger**: one task-wide ledger covers every paid call. Before each call the engine reserves its estimated cost (a conservative upper bound of input, cache and output tokens) and starts the call only if it fits; actual usage settles it; a call with an unknown outcome keeps its reservation. App-wide: one intake and one talker call in flight, and a session budget of about $1 for calls that belong to no task.
- **One retry owner, our loop**: the SDK's retries off. A call is retried on a rate limit (honouring `retry-after`), a server error, or a connection failure before the request was written (`ENOTFOUND`, `ECONNREFUSED`, TLS); a reset, timeout or stalled stream after sending is not retried. Never on auth, billing or invalid-request errors, except prompt-too-long, which triggers compaction and one retry.

| Role | Attempts, wall cap | When used up |
| --- | --- | --- |
| Talker label | 2 (second on Sonnet 5.5), about 8 s | "I can't reach my models right now; use the screen." |
| Intake check | 2, about 15 s | No task is created; the words stay on screen |
| Coordinator | 3 | Task incomplete, error kind |
| Worker step | 3, about 2 minutes per step | The worker returns incomplete |
| Deep plan, deep report | 2, about 3 minutes | Plan: incomplete; report: notes and sources shown |
| Done check judge | 2, about 1 minute | Incomplete, error kind, never done |

### Compaction

- First the deterministic prune: old tool outputs pruned; the goal, check list, refusals, pending bindings and todo note kept; never a pending tool call, question or plan. Later the middle summarised by a model, marked "background only, not a new instruction". Prompt-too-long after the prune ends the step incomplete, error kind.

### Memory

- Baymax builds its own memory and asks before it remembers. A proposed memory needs the user's yes and applies from the next task on; each entry records where and when it came from. A remembered preference guides the work but never approves a risky step.
- Learning in the background after a task: a helper re-reads the finished conversation and proposes skills and memories, pausing for a related task.
- Session recovery is separate from memory. What is deleted and what may be reused after a "no" is defined when memory is built, after its own research.

### Other V2 parts

- **Jev** (TypeSafe AI) picks the worker's model at `pickWorkerModel`; its PR keeps the check of about 20 task briefs (its pick against the expected pick, its latency, a timeout, and Sonnet 5.5 when it fails or is unsure).
- **Windows** through the split in `src/main/platform.ts`; permissions, packaging and audio still need work.
- **The user's own keys** with a Settings screen and `safeStorage`.
- **Model-written progress summaries.**
