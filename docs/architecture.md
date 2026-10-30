# Architecture — 26 Oct 2026

Decisions only. The design is split into four parts:

- **V1**, built now for the 31 Oct buildathon demo and the YC application ([V1 design](#v1-design)).
- **V1 if time remains**, built only after V1 works end to end ([list](#v1-if-time-remains)).
- **V2**, built later; its design is kept in [V2 design](#v2-design) so V1 can grow into it.
- **Out of Scope**, not planned now; any item can come back by an explicit decision ([list](#out-of-scope)).

Today the repo implements only the hold-key skeleton (`README.md`). Timings, counts and limits are starting values, tuned at build ([Starting values](#starting-values)).

**Rule for every cut.** V1 picks the option that is easiest to build and to reason about, with the fewest special cases. It keeps the seams the design names (task ids, goal versions, parent task ids, the ask, result events) and stable contracts (the engine port messages, the display state, the ask and result shapes), so a V2 part is added by extending them; internals behind those contracts may change.

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

**Wider direction**, for the pitch: information reaching people wherever they are, Baymax learning the user's taste, and an agent that also does tasks end to end. Only the items listed under [V2](#v2) are planned; V1 proves the information part on a Mac.

## Scope

### V1

- macOS only, English only, our own API keys from `.env`.
- Ask by holding Option and speaking, or by typing into the text box in the Baymax window. The build is text-first: the first slice is typed question -> front call -> worker -> done check -> card, and voice is wired in when it works.
- One task runs at a time; new tasks queue. One worker per task, no coordinator model.
- One research profile: the worker decides how much to search.
- Answers live in memory while the app is open; no database, no crash resume.
- The engine runs inside the main process behind a port.
- Cancel from the screen; speech silenced by the key or the mute switch.
- Streaming voice: Deepgram Flux STT and Aura-2 TTS over WebSockets, and one Fable front call that speaks first and then decides the route ([Voice](#voice), [Talker](#talker)).
- Friendly fixed failure lines; raw errors only in the dev log.

### V1 if time remains

Built only after everything in V1 works end to end; if time runs out, each waits for V2.

- Finished answers saved to a JSON file, so they survive a restart: serialized writes to a temporary file renamed in one step, a schema version, a failed save leaving the answer on screen marked unsaved, a malformed file never blocking start-up.
- The worker's todo list (an `update_todo` tool: done, in progress, left), shown on the task card.
- Firecrawl for JavaScript-only pages and PDFs, with TLS verification on and PDF pages capped, and the full web live test: three questions (a current fact, a niche documentation question, a Reddit discovery question) and four pages (static, JavaScript-only, a short PDF, a blocked or login page), scored on relevant results, usable text, traceable sources, time to the first useful result and a clear error on the blocked page; one cap for the whole test of about 25 Firecrawl credits and $1, model tokens included, and no automatic retries. Anthropic's web search and fetch are a candidate in the same test; they get a place only if they do well, and then run inside the `web` tool as its own small model call with the server tool's maximum uses capped at 1 (or the searches left), counted as a model call and as searches, with its result and citation blocks kept as returned.
- Typed input from any app: Option + Space opens the text box over the user's app and returns focus when it closes (not a double tap on Option, which would clash with holding it).

### V2

Each item's design is in [V2 design](#v2-design).

- Several tasks at once, each with its own coordinator; splitting a task across parallel workers with one writer.
- Deep research with a plan, many workers and a report file.
- The talker's labels, live words on screen and interruption-aware speech; the speech queue, "go on" and "what did I miss".
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
renderer                 main                                              engine (in main, behind the port)
text box    --IPC-->  --+
PCM frames  --IPC-->  Flux WebSocket -> final transcript -> front call (Fable)
                                                              |  1. one spoken line, streamed
playback    <--IPC--  Aura-2 WebSocket <- speak() <-----------+
                                                              |  2. decide(route, goal)
cards       <--IPC--  display state <- main checks, then routes --> runTask --> worker -> done check
                                                              <-- task events (progress, result, failed, cancelled)
```

- Typed text and a final transcript enter the same route: the [front call](#talker).
- Nothing acts before the full final sentence after key release. One Fable call then speaks a line and decides; main checks the decision in code and acts on it. No model step sits between the decision and the [worker](#worker-and-research).

### Stack

| Part | Choice |
| --- | --- |
| STT | Deepgram Flux (`flux-general-en`) over one warm WebSocket; backup Nova-3 pre-recorded for one utterance when the socket cannot reconnect |
| TTS | Deepgram Aura-2 over one warm WebSocket (24 kHz PCM), fed the front call's line sentence by sentence; backup the Aura-2 REST call |
| Front call | Claude Fable 5.1 at low effort, in main: a spoken line, then the route (`decide` tool) |
| Worker | Claude Sonnet 5.5, picked in code by `pickWorkerModel`, the seam Jev plugs into later |
| Web | One `web` tool owned by Baymax: a search provider (Exa, called with plain `fetch`) and page reads through Exa Contents, with Baymax's own plain reader as the fallback |
| Agent runtime | Our own loop on the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), in the engine |
| Storage | Memory only |
| Keys | Our own keys from `.env` ([Processes and the port](#processes-and-the-port)) |

- Claude only, with no automatic switch to another provider or model when one fails. Each role's model is one field; the models are measured in build week.
- No framework: our own pipeline and agent loop inside the app.

### Processes and the port

| Process | Runs | Owns |
| --- | --- | --- |
| Main | Hold-key, windows, IPC with the renderer, the Deepgram calls, `speak()`, the front call and its decision check, the engine behind its port | The shown state: the task list, its cards, the queue and the answers kept for follow-ups |
| Engine (inside main in V1) | The task runner: worker, done check, limits, the worker model pick | The running task's state |
| Renderer | Text box, cards, mic recording, playback | Nothing; it shows what main sends |

- **The port.** The engine code lives in `src/engine/` and imports nothing from `src/main/`, the renderer or `electron`. It builds its own providers from `src/providers/`; its start takes only serializable values (keys, paths, settings), and test fakes enter through a separate optional parameter. Main and the engine talk only through one port object (`send`, `onMessage`, `close`) carrying plain JSON messages with ids, typed in `src/shared/engine.ts`. Cancel is a port message (`{ type: "cancel", taskId }`) that the engine maps to its own `AbortController`. V1 implements the port in-process; V2 swaps in a `utilityProcess` behind the same port.
- **Who runs what.** Main runs the front call at once for every question, typed or spoken, even while a task runs. Its decision says what the words are (chat, a clarifying question, a new task, a follow-up, the answer to the waiting question, or outside research) and carries a one-line goal; main checks it, then queues the task or sends the engine a run message when none runs. Only then does the engine's runner run the worker and the done check, attaching a queued follow-up's parent result at that moment, and report back through the port. Answers kept for follow-ups stay apart from the running task's state, so a database can later be added beside them.
- **The engine keeps nothing across tasks.** Main sends what each step needs: a run message carries the task id, goal version, depth and the ask (the front call's goal and the user's exact words), and for a follow-up its parent task id with the parent's outcome, goal, words, line, final answer and sources. Engine events carry kinds, plus model text said as written: `spokenLine` on a result and `reason` on a failure where nothing was found. Main owns the fixed lines. The worker never asks the user anything.
- **Why in main.** The reasons for a separate process (synchronous SQLite, crash resume, restart) are V2, the agent loop mostly waits on the network, the spike ran the loop inside main, and a separate process was never tested on this repo's Electron 40.
- **The risk and its limits.** Engine code that blocks would also freeze voice and cancel. V1 lowers this without guaranteeing against it: no `*Sync` calls anywhere in `src/`; every model and web call has an `AbortSignal` and a deadline; downloads are capped before parsing ([Web tool](#web-tool)); history and kept page text are bounded. Expected network, model and parsing failures are caught at their awaited task boundaries and end the task with a [failure line](#failures-the-user-hears). A truly uncaught exception or unhandled rejection is not attributed to a task and normal work is not resumed, because Node's state may be undefined: main logs it, shows "Baymax hit a problem and is restarting." and relaunches the app (`app.relaunch()`, then exit). A relaunched app that fails again within about 10 s of start exits instead of relaunching, so a start-up bug cannot loop. Only a separate process (V2) can stop a truly stuck engine.
- **Keys.** Main reads `.env` once at start, keeps the Deepgram, Anthropic and search keys, and deletes them from `process.env` before any window opens. The renderer gets no key and makes no network calls; the display state carries display fields only.
- One app instance: Electron's single-instance lock makes a second instance focus the first and exit.

### Voice

- **Listening.** At key-down the renderer starts the microphone (`getUserMedia`) and an AudioWorklet that sends 16 kHz 16-bit PCM frames to main over typed IPC; the microphone is on only while the key is held. The renderer also plays speech (Web Audio), because Chrome's echo canceller only removes audio Chrome itself plays (Electron issue #47043). A hold longer than the cap is ended by code as a key-up, and counts as a question.
- **Warm socket.** Main opens one Flux WebSocket at start (connecting takes about 1.7 s) with `eot_threshold=1.0` and `eot_timeout_ms=60000`, so Flux never ends a turn on a pause; one socket carries turn after turn. Flux rejects a `KeepAlive` message, so main sends about 100 ms of zero PCM every 5 s while idle. A closed socket reconnects with backoff. If the socket is not open at key-down, main reconnects at once and buffers the frames, then sends them when it opens; only if the reconnect fails is the utterance sent whole to Nova-3 pre-recorded.
- **Ending the turn.** At key release the renderer sends its last frames and an end-of-frames marker. After the marker, main sends about 200 ms of zero PCM at once (no wait) and then `ForceEndTurn`; without that silence the final came 1.8-2.7 s late in 3 of 8 runs, with it 0.41-0.49 s in 8 of 8. The final `EndOfTurn` is the transcript. If it has not come about 2 s after release, a partial `Update` is never used, since it can be a question cut short: the held audio goes to Nova-3 and whichever whole result comes first wins. If the end-of-frames marker is still pending at that point, the socket restarts, batch waits for the marker and takes the later frames too, and at about 5 s after release it goes with the audio it has.
- **Nothing said, or speech lost.** Flux gives the same reply for silence and for a whisper, so the hold's peak level tells them apart (one room and one mic so far: silence 1-1.5%, a whisper 5%, normal voice 29-43%). When Flux saw no turn (a `FORCE_END_TURN_NO_ACTIVE_TURN` warning) or its text is empty, any text kept from a Flux timeout goes on as the question. With no such text: under 3%, nothing was said, so no line is spoken and voice goes to `idle` at once; at 3% or more, speech was lost, so the held audio goes to Nova-3 and its words go on as a normal question. An empty Nova-3 result follows the same rule, on every path to batch: under 3% it is silent, at 3% or more Baymax says "I didn't catch that, say it again." A hold with no audio at all also gets that line. A provider failure keeps its own line. A no-turn hold at speech level restarts the Flux socket, because the ignored `ForceEndTurn` leaves its audio in Flux's open turn and those words would appear in the next hold.
- **Hold filter.** At release the hold tracker accepts or discards the hold: a hold under about 0.3 s, or one during which any other key was pressed (Option + arrow jumps a word in a terminal), is discarded silently, with no card. Its frames already reached Flux, so main still ends that turn and drops its transcript. Main passes the time with each key event, so the tracker stays pure; any key-down still silences speech at once. A blocked or missing microphone gets its own line, and Deepgram being unreachable shows voice unavailable instead ([failure lines](#failures-the-user-hears)). A late transcript for an old utterance is dropped. If the renderer dies or reloads while recording or playing, main ends that turn, drops its transcript and the playing line; a key still held stays held, so nothing is spoken until it is released. A voice failure never stops research that is running.
- **Speaking.** Baymax speaks in three places, and everything spoken is also on the screen: the [front call's](#talker) one line after a question (which is also the clarifying question when it asks one), the result's spoken line, and a failed task's line. Model text is spoken as given, never rewritten. The worker never speaks on its own and never asks the user anything. Progress shows on the screen only. Fixed [failure lines](#failures-the-user-hears) are spoken as written.
- **Sentences to Aura.** Text goes to the Aura socket only at a sentence end or at the end of the text, with a `Flush` each time, because Aura speaks each flush as its own utterance, with about 210 ms of silence at the join. A sentence end is `.`, `?` or `!` followed by a space or at the end of the text so far; a `.` right after a digit at the end of the text so far waits, since it could be the "3." of "3.5". Commas, colons and semicolons never cut, nothing cuts by characters, words or time, and the end of the text sends whatever is left. A long first sentence delays first audio, so the talker keeps its first sentence short.
- **Playback buffer.** Aura's audio arrives in bursts with a gap after the first 200 ms, up to 314 ms measured. A streamed line starts about 350 ms after its first chunk, with all its audio kept. Aura's leading silence is not trimmed: each dropped millisecond would take from the margin for that gap and put a stutter in the first word, and a level cutoff can delete quiet speech. No stutter comes before speed here.
- **One playback owner.** All speech goes through one `speak(line, kind)` function in main. Each line carries its task id; one line plays at a time and a new line waits for it; a line for a cancelled or replaced task is dropped. A key press, mute or cancel clears the pending lines as well as the one playing. Nothing is spoken while the key is held, and pressing the key while Baymax speaks silences it at once.
- **Voice phase** (29 Oct, for the notch pill). Main sends the screen one voice phase on its own channel, `idle`, `listening`, `thinking` or `speaking`, with the speaking line (its line id, task id or none for a notice, and kind), and replays it to a window that loads. Voice owns it, beside the hold state, because it follows speech and the hold rather than the task list. Listening is the held key. Thinking is a pending turn: it starts when a hold is accepted at release and covers the wait for the transcript and for the front call's first audio; it ends on a discarded hold, an empty or failed transcript, a front call whose line is dropped or never spoke (a failed attempt waiting for Retry is not thinking), a cancel, or mute. Speaking starts when a line's first audio is sent to the screen, on either path, and ends only for that line: playback finished, stopped, cancelled, timed out or the renderer reset. Queued synthesis is not speaking, and a line dropped by mute never speaks. The line kinds tell a done task's answer (`answer`) from a failure (`failure`), a question, a notice and the front call's line (`talk`).
- **Mute.** A switch turns speech off so everything shows on the screen only. It is a small toggle in the panel's top strip, reachable muted or not; the closed-panel voice pill also has a toggle while Baymax speaks: a second click unmutes. The state is main's; unmuting does not replay a stopped line.
- **Voice down.** When Deepgram is unreachable, nothing can be spoken: Baymax shows that voice is unavailable and points to the text box; earlier answers, cancel and card clicks keep working.

### Talker

- **What it is.** One Claude Fable 5.1 call in main per final transcript or typed question, and per clarifying answer clicked or typed on the question card. It is Baymax's front call: it writes one short spoken line as plain text, streamed into TTS as it arrives, then calls the `decide` tool once. Text after the tool starts is dropped, never spoken. Low effort; the request has no `thinking` field and no `tool_choice`, because Fable 5.1 rejects disabled thinking and a forced tool.
- **What it reads.** The conversation as real alternating turns (the last exchanges, [Starting values](#starting-values): the user's words, and what Baymax said, with a finished task's result line added), then the current words with tagged data blocks: the recent tasks (id, state, question, spoken answer, a bounded excerpt of the card), the running and waiting tasks (ids), and the waiting clarifying question with its ids and the request it belongs to. The history lives in main's memory only, and its last turn carries a cache mark.
- **What it decides.** `decide` gives the route, a short topic, the parent task id, the waiting question id it answers, the choices of a clarifying question (none, or two to four), and for a new task or follow-up a one-line goal that keeps every constraint of the user's words: the [worker](#worker-and-research) reads it directly, beside those words. Main checks it before anything starts ([Intake and tasks](#intake-and-tasks)).
- **What it says.** Chat: the whole answer ("hi", "thanks", a fact it knows, or an answer already written earlier in the conversation); a greeting or thanks gets a short reply and nothing else. Research: one line that shows it understood the question ("I'll check tomorrow's Delhi forecast; the rain chance decides the umbrella."), with no time promise and no claim of progress. A clarifying question: the line is the question. Outside research: it says plainly that this version only researches. Only a clarifying line asks a question.
- **Failure and time.** Two wall-clock deadlines, both from the start of the call ([Starting values](#starting-values)): one to the first non-empty text, and one for the whole call, retries included. On either expiry the call is aborted; a line still open is cut, and a line that has already ended is left alone. Both timers are cleared on every end of the attempt. A failed, timed-out or text-less call, or a decision that fails a check, ends in a [failure line](#failures-the-user-hears) with retry, and no worker starts. A cancelled, replaced or closed attempt changes nothing when it ends late.
- **Nothing is rewritten.** The worker's spoken line reaches the user as given, not through this call.
- **Warm connection.** A key press sends a key-less request to the Anthropic API, so the call reuses an open connection instead of setting one up (about 0.15 s, measured with a 401 call on 28 Oct).
- **No filler.** Nothing is said before the first words; a filler line ("One moment.") was tried and removed on 28 Oct because it delayed a talker that was nearly ready.
- **Measured (29 Oct, live spike: 12 calls, Fable 5.1, low effort).** Speech began at a median 756 ms (the earlier talker alone: 690 ms); the tool call came in 12 of 12 calls, always after the text and never followed by more text; the route was known at about 1.2-1.5 s, against 2.1-3.4 s for the earlier Sonnet intake. Not yet measured through the app: cache hits and latency of the finished code.

### Intake and tasks

There is no separate intake model call: the front call's `decide` tool is the intake, and main checks and applies it.

- **The decision check** is plain code in main, no model, and runs before anything starts, binds or ends. The route must be one of chat, clarify, newTask, followUp or outsideResearch. A clarify, newTask or followUp needs a non-empty topic; a newTask or followUp needs a non-empty goal; a clarify has no choices or two to four. A follow-up's parent must be a task created before this one, otherwise it is admitted as a new task and logged. A question id it answers must be the waiting question's, and that answer is never routed as clarify (no second question after an answer). A failed check starts no worker: the card fails with a retryable failure line.
- **Chat:** the spoken line was the whole answer: no worker, and the thinking card becomes a done card showing that line.
- **Clarify:** the spoken line is the question. The card is "clarifying" and shows the line as the question, with the choices if any; nothing more is said. A question that has to wait because another is shown is spoken as given when it shows.
- **New task and follow-up:** the card shows the spoken line, and the work starts at once or queues. Main sends the engine `runTask` with the goal and the user's exact words (for a clarifying answer: the original words, the question and the answer); the card is running as soon as the engine has it. There is no say-back and no start line on the card; the fixed queued and failure lines stay.
- **Outside research:** the card ends cancelled with the spoken line on it, and no task starts. The line was already said, so nothing else is.
- **Tasks and the queue.** Main keeps one list of tasks, each with an id and a state: thinking, clarifying, queued, running, done, failed or cancelled. At most three tasks wait while one runs. The front call still runs for every question, because the words may answer the waiting question; main refuses only a new task or follow-up when three already wait, with "I already have three waiting. Cancel one or ask again later.", and that card leaves like a cancelled one. A "thinking" card appears at key release (or on submit) before the front call returns, and its id becomes the task's id. Each task carries a goal version (always 1 in V1) and a depth value (always "normal" in V1).
- **Clarifying questions.** At most one waits at a time. The question may be open (no choices, answered in the card's text field) or have two to four choices, the first marked recommended, plus "something else". It is answered by voice, typing or click, bound to the question's id. One answer per id; a second click or a late answer is ignored; a spoken answer binds to the question shown when the key went down.
- **A clarifying answer is one front call.** Words that answer the waiting question are bound and routed in the same call. A click or typed answer on the question card runs the same call with the answer as the words and that question as the waiting question. An answer never creates another task and never asks a second question. Before it is applied, the waiting question is claimed at once: a second answer to the same question, a stale one, or one for a task that has ended is dropped and starts nothing. While a question waits, words that clearly do not answer it are a new request and are queued; the question stays pending.
- **Attempts and cancel.** Each front call is an attempt with its own id. Cancel on a card whose front call is in flight aborts it locally, silences its speech and cancels the card, with no engine message. Retry after a failure re-runs the same call with the same words and context, as a fresh attempt.
- **Follow-ups.** Each answer is stored under its task id. A follow-up gets a `parentTaskId`, and its run message carries the parent's outcome, goal, words, spoken line, answer and source references; an unrelated question starts without a parent. An admitted task saves its goal and words even when it found nothing; a record that never had an ask (a chat result, a cancel before admission) saves no goal and the card's words. A follow-up queued before its parent finishes keeps the parent reference and gets the parent's final result when it starts. If the parent failed or was cancelled, one sentence tells the worker so: it uses what the parent found, knowing it may be partial, or works from the request it has when nothing was found. It never asks the user, and it never runs as if a finished parent answer existed.
- **No steering.** Anything said while a task runs goes through the front call and is queued as a follow-up or a new question.

### Worker and research

- **What the worker gets.** Today's date, the user's exact words, the front call's one-line goal and, for a follow-up, the parent result, each escaped in its own tagged block. The goal fills in details missing from the words, and the words win when they clash, because a restated goal can lose a nuance ("an office laptop, not gaming"). The worker gets only the web tool and never the whole conversation. Text in a page is never an instruction to it.
- **It never asks.** The talker clears doubts before work starts. The worker works in the background and asks the user nothing: when words could mean different things, it takes the most likely meaning and says in its line which one it took.
- **One profile.** The worker decides while it works how much to search, within one set of [limits](#limits-and-cost). The question decides how far it goes: one fact may need one good page, and a comparison or a question with many parts needs more. It stops when another page would not change the answer and keeps going when sources disagree or part of the question is still open. There is no fixed number of sources, and code enforces no minimum. Each tool result tells the worker how many pages it has read and how many searches and steps are left. Whether it now stops too early is not measured; the measuring run checks it, and if the worker over-searches or is too slow, a quick or normal choice made by the front call comes back through the depth value.
- **The answer.** One model output with four fields: `report` (Markdown for the screen, no links or source ids, empty when the answer fits in the line), `line` (one or two short sentences, spoken once and also shown as the card's summary, with no fixed wording), `sourceIds` (the read pages that back them) and `nothingFound` (null, or one plain sentence on why nothing helped, with the report and the line empty). There is no separate writer and no separate model call for the line. The report is never read out. A near match is never called a full match: with no exact match it names the closest ones and what they miss.
- **Prompt cache.** The prompt start (instructions and tool list) stays fixed during a run.
- **Context.** If the prompt fills up despite the capped page text, the run stops at a limit and ends as below.
- **How a run ends.** One result event or one failed event, or cancelled when the user cancels. A valid answer ends as a result. An answer that means nothing found ends failed, cause `nothingFound`, with its sentence as the reason and the pages read as a list, or nothing when no page was read. A limit or an error with no valid answer, including a second bad answer, ends failed with that cause and the pages read as a list, or nothing when no page was read. A valid answer ends the run at once, so no limit or error can follow it. No line, spoken or shown, says done, incomplete or "found little".

### Done check

It checks the answer's form and its source ids, not whether the pages back the report or the goal is met. V1 has no judge: in the 29 Oct live test it failed every answer and tripled the task cost; the code check is the done check.

- The web tool keeps every page it read in code: source id, URL and capped text. The worker's `sourceIds` name those ids; the report itself carries no ids or links.
- **Code check:** ids of pages that were not read are dropped silently; an id from a search snippet only never counts. A non-empty `nothingFound` with an empty line and an empty report means nothing found. Otherwise the answer is invalid when its line is empty, when no read id is left, or when `nothingFound` is not null. Everything else is valid, an empty report included: the card text is the report with links and source markers stripped, and the card's sources are the pages with those ids. A valid answer ends the task at once, with no further model call.
- **What is kept.** An answer is kept only after its check passes, including with an empty report. A rejected answer's text is never promoted to the card, and its line is never spoken.
- **One rewrite.** A cut-off, malformed or invalid answer gets exactly one rewrite in the same conversation, with its fault named. An answer turn with no text or with several text blocks counts as malformed. There are no research rounds. A second bad answer ends the task failed, cause `error`.
- Baymax closes a task itself once the check passes and the result is shown.

### Web tool

- Searches and page reads need no approval; the task's limits and cancel hold them in check.
- A page is read through Exa Contents first, with up to 20,000 characters of text; Exa's crawler also gives text for JavaScript-built pages and PDFs. When Exa gives no usable text for that URL, or its call fails for any reason except a cancel, Baymax's own reader reads the page plainly with HTML-to-text, where a JavaScript-only page or a PDF counts as no usable text and the worker moves on. Kept text is capped at 20,000 characters on both paths.
- **Exa as a hosted reader.** The URL rules run first, for both paths, so localhost, `.local`, literal private addresses, a URL with credentials and the refused sites never reach Exa. Exa fetches from its own servers, which cannot reach the user's local network, so the rule that protects the local network holds for it; the connection-time address check below belongs to Baymax's own reader, which keeps every rule. The kept page's URL is the checked URL that was asked for; Exa's own URL is used only to match its result. Exa's call has its own timeout, and its reply is refused when its declared size is over 1 MB; its text counts only when Exa marks that URL as a success.
- **Safety.** Only http and https. Only public destinations: the address the HTTP client actually connects to is checked at connection time (its own DNS lookup, IPv4 and IPv6), on every redirect and every retry, so localhost, `.local`, private and link-local ranges are refused even when a public-looking name resolves to them. A NAT64 address (`64:ff9b::/96`, which macOS returns for IPv4-only sites on a NAT64 network) is decided by the IPv4 address it carries. If that cannot be built and verified in V1, the reader route is narrowed rather than the gap called harmless. x.com, linkedin.com and reddit.com are refused. A URL that carries credentials is refused, and no cookies or credentials are forwarded. TLS is verified. Download size and time are capped before parsing. A hosted reader is used only if it keeps the same rules.
- **Page text is untrusted** for the worker. The worker cannot act outside, but an injected page could still skew an answer or steer later searches and fetches, so page text never changes the instructions or the tool list. Offline tests cover injected instructions, private addresses (including a name that resolves to one) and redirects.
- Exa's API host (api.exa.ai) is never read as a page, so a provider endpoint can never become a source; Exa's own site and docs stay readable.
- X, Reddit and LinkedIn appear only as links and snippets from a normal search, and Baymax says it did not read the full thread.

### Cancel

- Cancel is a screen control: the user hovers a task's card or agent icon and clicks cancel. Main serves it in code, so it works when no model or Deepgram is reachable. There is no spoken "stop" in V1.
- It covers the whole task: its front call, its waiting question, its worker, the rewrite and its speech. It blocks every later step and every late result, and nothing starts on its own afterwards.
- The card shows "cancelling", then "cancelled" only after the loop has really ended. A request already sent may still finish and be billed.
- Each queued card has its own cancel; cancelling one task leaves the others.

### Screen and cards

- Main sends the screen its whole display state each time something changes, never keys, clients, prompts or raw provider objects. A window that subscribes or reloads gets the current state at once.
- All changes go through one state-update path in main, which drops a late callback from a cancelled or finished step before it can publish.
- **Cards** (29 Oct, for the 30 Oct demo, in the locked notch design's look: Space Mono, white on black glass, no colour). The panel shows one list: cards that need you, then work in flight, then results. The top strip shows a status line ("1 needs you · 1 running", "3 results", "Nothing running"; chat replies and failed cards are not counted) and the mute toggle. A running, queued or thinking card shows its state, the title (the front call's topic, or the words until there is one) and one live progress line that shimmers only while work is pending, with a round stop button. The clarifying card shows only the question ("Needs you · <words>", then the question and "Say it or type below"); it is answered by voice or through the panel's field, whose words main binds to the waiting question; choices are not shown. The result card shows the title on one line, the worker's line as a summary, the report when it is not empty, and its underlined sources. A chat reply is a small card with only its text. The task card also carries a done task's spoken result line (`spokenLine`), which the answer island shows. A failed card shows its line and anything found. A failure or status line, Retry and stop stay wherever they apply. The front call's line for a research request is spoken but no longer printed on its card; a chat reply and a request outside research still show it. Tabs, the card deck and Copy/Open come after the demo. Answers render as Markdown with `react-markdown`: raw HTML skipped, no raw-HTML plugin, no images. Sources show below the answer, never inside it; a source opens through one typed main action, which opens a URL only if it is one of the task's read sources; renderer navigation and pop-ups are blocked. The look and fonts are set on the design canvas (record: `notch-design-locked.md`).
- **The window** unfolds from the MacBook notch at the top centre, with the cards and the text box (HeyClicky as the pattern reference, our own look); a screen without a notch gets the same shape as a top-centre pill. Electron documents that a macOS window cannot go above the menu bar height, so a time-boxed spike on the demo Mac decides the route before the window is built: Electron window settings first, then a small native addon that places the window, and only by an explicit decision another toolkit; a shape flush under the menu bar is the last-resort look.
- **The panel** (29 Oct; shape, size and timing reworked 30 Oct). One fixed, transparent, click-through window sits over the notch and never resizes; only the black shape and its content move inside it, drawn frame by frame so clicks land only on what is drawn. The window is 688 pt wide (the widest panel plus its two ears) and 560 pt tall, or the screen's work area height minus 16 pt when that is less. Main reads each Mac's real notch from `NSScreen` (width from the auxiliary top areas, height from the top safe-area inset), matches it to the chosen display by id, re-reads it when the displays change, and sends the renderer the size; with no notch or a failed read the screen keeps a small pill at rest. On a notched Mac nothing is drawn at rest, only the hardware notch shows; the black shape appears when something opens. Each shape has its own concave ear joining the screen's top edge: panel and island 24 pt, pill 14 pt, ring 8 pt; a shape's ear and bottom corner share its height. The panel fits its content: 420 to 520 pt wide (640 pt while a full report is open), up to 420 pt tall (560 pt with a full report), and never past the window; past that height only the list scrolls, and size changes animate over 260 ms. The panel opens only when the pointer rests 200 ms on the notch itself; the pill's and ring's wings never open it; voice, notices and new or finished cards leave it closed. The Accessibility hint is the one exception: it holds the panel open while access is missing. With an empty field the panel closes 300 ms after the pointer leaves, unless a mouse button pressed inside is still down; with text in the field it closes after 3 s, each key typed outside restarts that, and the pointer coming back stops it. Main watches the cursor while the window holds the mouse, so a pointer that leaves the window with no last move still counts as gone. Esc in the panel's field closes it at once, a Space change closes it too, and both keep the text. Click-outside close and Esc from other apps wait for a main-process input observer after the demo. With the panel closed, the notch grows into the voice pill from main's [voice phase](#voice): Listening (50 ms after the key, growing over 200 ms), Thinking or Speaking, with a mute toggle while Baymax speaks. After speech, or 800 ms after a mute click, it closes back into the notch over 420 ms; a hold with nothing said closes it at once over 260 ms, also the panel's close. The pill shows only while the panel is closed. While tasks run or wait with the panel closed, the notch grows a little and shows a spinning ring (and the count from two tasks). When a done task's answer line speaks with the panel closed, the pill grows into the answer island: the task's title and its spoken line in a card; it closes as soon as the line ends, back to the notch or the ring. Hovering the island never opens the panel; a click on its card opens the panel on that result. A chat reply, a failed line, a question and a notice use the pill (the chat-reply island waits until after the demo). Sizes and timings: the locked notch design record (`notch-design-locked.md`, from the design canvas), and its 30 Oct updates in `design-lock-shape.md` and `design-lock-timing.md`.
- **Card lifetime.** A done or failed card never closes by itself: it stays in the panel (for the demo the card has no close control; main still accepts a close). A cancelled card shows "cancelled" and leaves after about 3 s.
- **Progress** is minimal: the task card shows the latest step as a line built by code from the tool's own arguments ("searching: how Hermes works", "reading github.com"), never from page text. A count of sources read is still sent but not shown. The engine emits these as small structured progress events.

### Limits and cost

- Each task has limits on model calls, searches, active time and dollars ([Starting values](#starting-values)). Active time counts the time the task's calls, tools or retry waits run, not the time it waits for the user. At a limit the run [ends as described](#worker-and-research) and shows what it found. The model-call limit is a ceiling, not a promise that the rewrite fits, and the time or dollar limit can end a task first. The dollar limit counts model calls only; Exa search and contents calls are not added to it in V1.
- Every engine model call (the worker's steps and its rewrite) goes through one dispatch function that checks the limits before sending, sets an output-token ceiling per role, and writes usage and dollar cost to the dev log for the team. Exa search and contents calls go through the web tool, with their own timeouts and the search limit, and are not dispatched. The user never sees cost. Without a reservation ledger the dollar limit is a conservative estimate, not an exact guarantee.
- In V1 a task's limits count its run (the worker's steps and its rewrite). The front call runs in main, outside them: one streamed call per utterance with its own two deadlines ([Talker](#talker)), its tokens and cache reads logged in the dev log.
- Retries use the Anthropic SDK's own retry with a small `maxRetries` and an explicit timeout on every call. That it may resend a request after a timeout is an accepted V1 cost.

### Failures the user hears

- Failures are told to the end user, not to a developer: a plain, fixed line written in code that says what is not working and what to do, shown on the card and spoken unless muted or voice is down. Error codes and provider messages go only to the dev log. A failing provider never closes the app.

| Failure | Line |
| --- | --- |
| Words not caught | "I didn't catch that, say it again." Not said when a newer hold has already started. |
| Microphone blocked | "I can't use the microphone. Allow Baymax in System Settings, Privacy and Security, Microphone, or type your question." |
| No microphone | "I can't find a microphone. Connect one, or type your question." |
| Voice unavailable | "Voice isn't working right now. You can type your question instead." |
| Models unreachable | "I can't reach my models right now. Try again in a few minutes." |
| Search not working | "Search isn't working right now. Try again in a few minutes." |
| Search key rejected / quota reached | "Baymax's search service rejected its key. Please tell the person who set up Baymax." / "Baymax's search service has reached its quota. Please tell the person who set up Baymax." |
| Model key rejected / no credit | "Baymax's model service rejected its key. Please tell the person who set up Baymax." / "Baymax's model service has no credit left. Please tell the person who set up Baymax." |
| Request outside research | The front call's own spoken line, which says plainly that this version only researches |
| Front call failed, key rejected / no credit | The key or credit line above, with retry; no task starts |
| Front call failed or timed out with nothing spoken | "Sorry, I missed that. Ask again." with retry; no task starts |
| Front call failed or timed out after it spoke, or its decision failed the check | "That didn't go through. Ask again." with retry; no task starts |
| Nothing found | The worker's own sentence on why, spoken and shown. The pages read stay on the card |
| Limit hit with no valid answer | "I ran out of time on that one before I had an answer." The pages read stay on the card |
| Error with no valid answer, including a second bad answer | "I hit an error on that question. Try again." The pages read stay on the card |
| Uncaught failure | "Baymax hit a problem and is restarting." |

A failed task says one short fixed line and shows it as the card's line. The exact lines are tuned by ear once the voice is heard live.

### Platform

- Electron 40.2.1 (Node 24.11.1), all TypeScript. macOS only.
- Hold-key via `uiohook-napi`: Option on macOS, which needs the Accessibility permission. Mic: `NSMicrophoneUsageDescription` and the audio-input entitlement.
- The Baymax window shows over the user's app without taking keyboard focus when a voice question is asked or an answer arrives.

### Starting values

| What | Starting value |
| --- | --- |
| Longest hold | about 90 s |
| First spoken line, target | under about 3 s after key release |
| Flux silence keep-alive | about 100 ms of zero PCM every 5 s |
| Zero PCM before `ForceEndTurn` | about 200 ms, sent at once |
| Final transcript deadline after key release | about 2 s, then the held audio goes to Nova-3; a partial `Update` is never used |
| Searches per task | about 20 |
| Active time per task | about 4 minutes |
| Model calls per task | about 30 |
| Dollars per task | about 50 cents |
| Rewrites of a bad answer | 1 |
| Shortest hold that counts as a question | about 0.3 s |
| Tasks waiting while one runs | 3 |
| Cancelled card stays | about 3 s |
| Output-token ceilings | front call 2,048, worker 2,048 per step |
| Model call retries and timeouts | the SDK's own retry, 1 per call; timeout per attempt: worker 60 s; whole call: twice the attempt timeout plus 5 s, capped by the task's remaining active time. The front call is one attempt with two wall-clock limits: 6 s to the first words, 30 s whole, retries included |
| Conversation history | the last 20 exchanges (30 kept), in main's memory only |

### Checks

Run before the code that depends on them:

1. The Anthropic SDK's retry and timeout defaults and its error causes for a dropped connection.
2. What Electron 40's main process does on an uncaught exception and an unhandled rejection.
3. The search provider on the demo pair and one current-fact question, in the web tool's first PR. Done in ticket #15: Exa was picked over Tavily.
4. The notch window spike on the demo Mac, before the window is built.

Which Deepgram models the key reaches is not a separate check: the first voice PR's first real call shows it.

**The demo pair.** The demo asks "how does Hermes agent work inside?" from Claude Code, then the follow-up "how is it different from Claude Code?". The search provider check and the tuning of the worker and the done check use this pair plus the current-fact question of the one-profile measurement. A working demo pair is not by itself V1 validation: limits, cancel and provider failures are proven by offline tests.

In build week: the time to the first spoken line; mic timing (first word, cold and warm) and the held-clip transcript; the one-profile measurement above.

### Folder map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Main process entry: keys, engine start, wiring, hotkey, restart on an uncaught failure |
| `src/preload.ts` | Bridge between main and renderer (`window.baymax`) |
| `src/renderer.ts`, `src/renderer/` | The screen (React): text box, cards, mic recording, playback |
| `src/renderer/microphone.ts` | The microphone while the key is held: PCM frames to main, then one end or failure |
| `src/renderer/capture.ts` | The Web Audio capture: an AudioWorklet, loaded as a data URL, that posts 16 kHz PCM frames |
| `src/renderer/pcm.ts` | Microphone samples to 16 kHz mono 16-bit PCM, and streamed speech PCM back to samples; pure |
| `src/renderer/playback.ts` | Playback of spoken lines: a whole REST clip, or one line's streamed chunks in seq order until its end |
| `src/renderer/web-audio.ts` | The Web Audio player: decodes a whole clip, or schedules PCM chunks back to back on one timeline |
| `src/renderer/notch/` | The shell that unfolds from the notch: the open and close rules, the voice pill's and answer island's lifecycle and the closed view choice (pure), the shape and its motion plans, the running ring, pointer hit-testing and click capture |
| `src/renderer/cards/` | The task card in each state (running, clarifying, result) with its answer and sources, the form each state takes, and the order of the list |
| `src/main/` | Main process: hold-key, windows, Deepgram calls, `speak()`, the task list and shown state, the engine behind its port |
| `src/main/hotkey.ts` | Hold-key detection |
| `src/main/hold.ts` | Hold state and the accept or discard outcome from key events and the time; pure |
| `src/main/platform.ts` | Platform flags and labels; the Mac's notch reading and Space changes |
| `src/main/recording.ts` | One utterance: recording commands, the mic audio, the transcript in hold order; discarded holds and late transcripts dropped |
| `src/main/flux-turns.ts` | Flux turns bound to held utterances: sending order, `ForceEndTurn`, the final-transcript deadline and the Nova-3 batch fallback; the held utterance and its end: delivery once, the turn ended on the socket, the batch call |
| `src/main/speech.ts` | `speak()`: the one playback owner — one line at a time, silenced by the key, mute or cancel, with a deadline on each playing line; a line streams sentence by sentence over the open Aura socket and uses the Aura-2 REST call, which also reports voice down, when the socket is not open or closes before any audio; a socket that closes after audio drops the rest of the line |
| `src/main/clauses.ts` | Text cut into whole sentences for streamed speech; pure |
| `src/main/voice.ts` | Voice wiring: hold routing, recording and speech joined to main's state, STT and TTS health, the first-line and final-transcript timing; what voice does with a held utterance's result (its words to main's state, or the line for words not caught); the voice phase the screen shows: listening, the pending turn (thinking) and the speaking line |
| `src/main/voice-timing.ts` | Dev-log timing of voice: each generation's front-call steps in ms after its release, and gaps where streamed speech ran dry |
| `src/main/talker.ts` | The front call: one Fable 5.1 streaming call per question or clarifying answer; its line streams into speech, then its `decide` input is handed to main; the two deadlines, attempts and cancel; its instructions, the `decide` tool and the messages it reads |
| `src/main/window.ts` | The Baymax window: the notch panel at the top centre, shown without focus, click-through outside its shape; its window channels on its own webContents (`windowShape`, `setMouseCapture`, and to the page `pointerOutside` and `spaceChanged`); the real notch size re-read when displays change; navigation and pop-ups blocked |
| `src/main/panel-geometry.ts` | The window's bounds on the chosen display and its notch shape from the measured sizes; pure |
| `src/main/keys.ts` | Reads the API keys once from an injected environment and removes them from it |
| `src/main/env-file.ts` | Reads `.env` from the app path into the environment once; a name the shell already set keeps its value |
| `src/main/restart.ts` | The restart path: the restarting line, work stopped, one relaunch after a short delay, and the loop guard |
| `src/main/wiring.ts` | Connects main's state to voice, the engine port and the renderer actions; a state throw goes to the restart path |
| `src/main/renderer-actions.ts` | The renderer -> main actions: sender and payload checks, then one state or voice call each |
| `src/main/tasks/` | Main's shown state: the task list and queue, card lifetime and the fixed lines, through one update path. It asks the front call through talk requests (`talk.ts`), checks its decision (`decision.ts`), keeps the attempts and retries and applies each route (`front.ts`), ends cards (`run.ts`), shows and says the waiting questions (`record.ts`), binds clarifying answers (`ask.ts`) and keeps the conversation history (`history.ts`) |
| `src/engine/index.ts` | Engine entry: the start function and the port; wires in the plugs |
| `src/engine/core/` | What every plug shares: the task runner, the worker loop, the dispatch function and limits |
| `src/engine/plugs/research/` | The research plug: the web tool (safe page reads, pages kept by source id), its prompts and its done condition |
| `src/engine/plugs/index.ts` | The one list of plugs, as explicit re-exports |
| `src/shared/ipc.ts` | Renderer <-> main channel names and payload types |
| `src/shared/engine.ts` | Main <-> engine port message types |
| `src/shared/cards.ts` | Types both links carry: ids, sources, the clarifying question, findings, the task card (with a done task's spoken line) and the display state |
| `src/providers/` | Process-neutral provider code: the Exa search and page-contents calls and their outcome types, the Anthropic call with its timeout and usage record, and its streamed form for the front call (text, then one tool call), the Deepgram calls. Imports nothing from a process folder |
| `src/providers/deepgram.ts` | Deepgram calls: pre-recorded transcription and REST speech |
| `src/providers/warm-socket.ts` | A socket kept open from start that reconnects with backoff, and the real WebSocket opener |
| `src/providers/flux.ts` | The Flux socket: the listen URL, its messages, the silence keep-alive and ending a turn |
| `src/providers/aura.ts` | The Aura-2 speak socket: its URL, `Speak`, `Flush` and `Clear`, and its messages |
| `src/providers/wav.ts` | A WAV header in front of held PCM for the batch call |
| `tests/` | Tests and harnesses, at the same relative path as the code they cover; imported by nothing in `src/` |

- A plug is its tools, its prompts and its done condition; a new kind of work adds a plug folder and leaves the core alone. No `Plug` interface until a second plug exists. The core imports no concrete plug; only the engine entry wires in `plugs/index.ts`.
- `src/engine/` imports nothing from `src/main/`, `src/renderer/` or `electron`. `src/main/` imports the engine only through `src/engine/index.ts`. The renderer never imports `src/shared/engine.ts` or the engine.
- `src/shared/` holds only process-neutral contracts. A link file (`ipc.ts`, `engine.ts`) imports the shared type files; link files never import each other.

Config changes in the first build PR (asked first):

- `tsconfig.json` `target` to `ES2022` and TypeScript to 5.x, so the SDK's streams are read with native `for await` on a current TypeScript (TypeScript 4.5.5 already type-checks `for await` through the lib that `@types/node` loads, so that was not the reason); checked against the SDK's minimum TypeScript, `@typescript-eslint` and `fork-ts-checker`.
- `.eslintrc.json`: extend the `import/no-restricted-paths` zones (the engine never imports main, the renderer or `electron`; main imports the engine only through its entry; the renderer never imports `src/shared/engine.ts`; `src/providers/` imports no process folder); keep the `*Sync` rule over all of `src/`; add `src/engine/index.ts` to `ignoreExports`; set `ignoreUnusedTypeExports` so a types-only contract passes lint; give `src/engine/**` an override with `env.browser: false`; show each changed rule failing on a bad example.
- Dependencies: `@anthropic-ai/sdk` and `react-markdown`; Deepgram and the search provider are called with plain `fetch`. `.env.example` drops `OPENROUTER_API_KEY` and gains the search provider key names. TypeScript 5.x likely needs a newer `@typescript-eslint`.
- The microphone usage description and the audio-input entitlement in the packaging config.
- CI moves from `windows-latest` to `macos-latest`.

### Set at build

- The exact message shapes in `src/shared/ipc.ts` and `src/shared/engine.ts`; the files inside `src/engine/core/` beyond this map.
- Prompts, including the front call's (how much of the recent record it sees).
- Result details: card layout, how many sources show, spoken length.
- Whether a second utterance waits while a front call is in flight.
- The failed card's choices (starting form: "search more", "change the question", "try again").
- Each tool's abort time.
- The fixed spoken lines, tuned by ear.

## V2 design

Kept from the 26 Oct design freeze so V1 can grow into it. Each part says what it adds to V1; facts already in [V1 design](#v1-design) are not repeated.

### Several tasks and the coordinator

- **One coordinator per task**: its own Sonnet 5.5 conversation, between the intake check and the workers. It starts with the task and ends after the done check or a stop; it wakes for a user message for that task or a worker's question, result, incomplete or death, and sleeps at no cost between calls. The user still sees one Baymax.
- At most 3 active tasks; a fourth is queued and the user told. V1's task list and per-task state, cancel and limits make this a raised limit. The 1-hour prompt cache for coordinator and plan calls is decided at build.
- **The intake check** additionally settles which task the words belong to (a new task, possibly with a parent; a follow-up or steer of a running task; a reopen of a finished one) and the research depth. A card under the pointer or the held key fixes the target before any model is asked. "Stop everything" voids an intake call in flight, so a late reply never starts a task.
- **What a coordinator keeps**: the user's words for the task, the goal and check list, the workers' reports and the user's mid-run messages. A new task inherits from its parent only the result, the goal line and the short conversation record, and can ask for an earlier task's full log.
- **Goal and check list**: every task starts with a short goal and check list (the expected result, the constraints that matter, how done is verified), from the deep plan or the say-back, and follows the new goal version after a steer.
- **Preferences**: today's audience or purpose is never inferred from past tasks, and what the user supplied this time is not asked again.

### Workers, splitting and the writer

- **Todo note**: in long runs the worker rewrites a short note every few steps (the goal, what is done, what is left, the errors so far), so failed steps are not repeated; V1's optional `update_todo` grows into it.
- **Splitting**: the coordinator splits a task into sub-questions, one worker each, within the parallel-worker limit ([Deep research](#deep-research)), grouping them or running bounded waves. Reaching that limit is not a failure.
- **Messages carried by the engine**: the brief (coordinator to worker, once); a question, asked while the worker stays alive (worker to coordinator, which answers from the user's words or the goal, or asks the user and passes back the bound answer); a steer or stop (under queue / send now and the goal version); the result (done with notes and evidence, or incomplete with its kind and reason). An approval request goes from the worker's code to the user through main, bound by id; the coordinator is told, never asked, and no model sits in the authority path. Progress goes from the worker's code to the screen, not through the coordinator, and the coordinator reads a worker's log only when its result arrives.
- **One writer**: workers return notes and evidence records, not finished text; one writer writes the result from all notes (Opus 5.5 for a deep report; the writer for normal research is set at build). For quick research the single worker's answer is the result and no writer runs. The coordinator never merges text; it runs the done check on the written result.
- **Continue**: missing evidence goes back as a bounded brief to that item's worker, a writing fault to the writer, and the revised result is checked again under the current goal version and remaining limits (2 rounds per task). A note made for an old goal version is caught before the writer sees it.
- **Budget split**: a reserve (about 40 percent of a deep task's dollar limit) is kept for the coordinator, writer and done check; the rest is split among workers through their briefs, and a worker's unused share returns when it ends. A worker that uses up its share ends with what it saved and returns incomplete; the coordinator decides once.
- **Worker death** in a living engine: screen only; its line shows "ended unexpectedly"; the coordinator restarts it once from its saved notes or ends the task incomplete, error kind. One spoken line per task outcome, never per worker.

### Deep research

- Depths: quick (one or two searches, a direct answer, Haiku 5.5), normal (moderate search, Sonnet 5.5) and deep (a full run with a cited report). The intake chooses from the meaning of the request, not from words like "deep"; the say-back names it, the user changes it in a word, and Baymax asks when unsure.
- Deep first shows a plan made by Opus 5.5 and waits for "go" or a change. An explicit "go ahead directly" skips the wait: the plan is still made and used as the check list, the skipped wait is never recorded as approval, and neither missing-intent questions nor [action approvals](#approvals-and-actions) are skipped. "Stop" while a plan waits stops the task before any worker starts.
- The report is UTF-8 Markdown in an app-owned reports folder under Electron's user-data path, named by task id and goal version, never overwritten, written to a temporary file and renamed; main records the artifact id and the renderer opens it through one typed main action. A deep result is a two-line spoken summary and a card that opens the report.
- Opus 5.5 versus Fable 5.1 on one report; Fable only if clearly better and inside the cost target (about 50 cents a deep task).
- Starting limits per depth:

| Depth | Workers | Model calls | Searches | Active time | Dollar limit | Cost target |
| --- | --- | --- | --- | --- | --- | --- |
| Quick | 1 | about 4 to 5 | 2 | 1 minute | about 2 cents | about 1 cent |
| Normal | up to 3 | about 15 | 8 | 5 minutes | about 50 cents | set at build |
| Deep | up to 5 | about 60 | 30 | 20 minutes | about 75 cents | about 50 cents |

### Talker labels and streaming voice

- **Talker labels**: V1's [talker](#talker) also labels what the user said: yes, no (with the reason), stop, answer (with the chosen option or the "something else" text), go on, progress, correction, new task, unclear. Code binds the first six; the rest go to the intake check. Its retry is in the [retry table](#cost-ledger-and-retry-owner). A short delay before a voice-started task begins, so the user can still say "wait", is set at build (starting value: none).
- **Streaming voice, beyond V1**: live words on screen, and a warm mic with about 0.3 s of pre-key audio if measuring shows the first word is lost. Flux TTS (swap: ElevenLabs) with Ping keep-alive and `Interrupt` carrying the session-wide playback offset, which is how `text_spoken` is known. With Aura-2 only, a notice counts as heard on the renderer's playback-finished report alone and is replayed whole after an interruption. If TTS drops mid-line, main reconnects and the notice stays unheard; when `text_spoken` is unknown about 1 s after a key cut, the whole line counts as not heard; stale audio frames are rejected. STT swap: Cartesia Ink-2. Speech-to-speech models stay [out of scope](#out-of-scope) until the V1 pipeline is measured too slow.

### Speech queue

- One speech queue in main, in this order: (1) approval or question, (2) stuck or failed, (3) done, (4) progress (screen only unless asked). V1's `speak()` becomes this queue. Several waiting notices become one line ("two tasks done, one needs your OK"); a new notice never interrupts a line being spoken; an approval or failure during speech gives a short sound and is spoken after.
- **Key press while speaking**: the next words decide a correction (answered knowing how much was heard from `text_spoken`), a new task or "go on", which continues from the cut word.
- **"What did I miss"**: main holds one notice list, saved through the engine; Baymax speaks the notices not yet heard or opened (heard = played to the end without a key cut, confirmed by the renderer's playback-finished report and `text_spoken`; opened = its card opened), or says nothing is new and offers the last few.
- **"How far along?"** is answered by code from the state, the goal version and the counts, never as a percentage. Later: a read-only helper model that reads the log.

### Controls: voice stop and steering

- **Stop has three scopes**: this reply, this task, everything. A plain "stop": if Baymax is speaking it silences the speech; otherwise it stops the latest task; "stop everything" stops all. Code catches the complete final utterance "stop" or "stop everything" with no model call and consumes its utterance id. Voice commands call V1's cancel function. "Stop" with nothing running gets "Nothing is running."; a stop is said back as "Stopping {task}." or "Stopping everything.", then "Stopped {task}; {what still runs}."
- **States**: received, stopping, stopped; "stopped" is never claimed without evidence that the work ended. A stop by the user and a stop by the system (timer, limit, crash, forced end) are recorded apart.
- **Messages to a working task**: queue (read at the next safe point; a newer queued instruction supersedes older ones), send now (the reply in progress is cancelled, its partial text kept, the user's message added; a running tool finishes first), or stop. The safe points, which tools may be interrupted and whether "send now" becomes "queue" while workers run are set at build.
- **Goal versions**: a steer raises the version, which is checked before each consequential action and before the writer sees a note; old approvals become void. "Applied" is shown only once work follows the new instruction. At dispatch the engine claims the item's binding atomically and re-checks the stop and the goal version.
- **Reopen**: a later "this is wrong" reopens a finished task and continues its conversation.

### Approvals and actions

- **Authority**: only the user grants it. Text from a page, a memory entry or another agent's report is never an approval. A request to draft is not permission to send.
- **What needs approval**: only tools that act outside (send, delete, pay). Each tool declares where it runs, what effects it may have, where approval can really stop it, and whether it can be cancelled. Rollback of the user's files (copy before change) comes with the first plug that edits them.
- **Binding**: an approval is bound to the run, the tool call, its final arguments and the goal label; one answer per item; a changed request voids it, and a late "yes" to it gets "That request changed; here is the new one." Pending items are taken as they were at key-down; if a new one arrived while the user spoke, Baymax asks "which one?". Approvals are asked one at a time through the speech queue; a bare "yes" approves only an approval the user sees in full. The card offers "allow once" and "no"; a lasting rule would be memory, which asks first. A pending approval has no time limit, and the waiting agent makes no model calls.
- **A "no" is information**: the reason goes to the agent for the rest of the task; it never reaches a refused result by another route; after several refusals in a row it asks what the user wants.
- **Uncertain action** ("may have happened"): "It happened" marks the step done; "Leave it" marks it not done; "Do it again" is a new approval for a live agent under the current goal version.
- The approval ledger and binding can be built from the spike controller and tested offline with a fake tool before the first plug that acts outside.

### Full UI contract and step log

- **Received, then applied**: every user action shows two steps and its card stays until a final outcome. Received: for a click once main has taken the item's id, for voice once the words are labelled and the target picked. Applied: for a yes, the approved tool has started; for a no, an answer, a queued message or a steer, the engine has saved the input and the worker's next step has started (for a steer, under the new goal version). An action can also end refused, superseded, failed or uncertain.
- **Ids and refusal**: every card, pending item and action has its own id; a stale id or a second answer is refused with its reason shown (question changed, already answered, agent stopped, goal changed); a repeat of the same action id gets the first outcome back.
- **Snapshot plus numbered updates**: one ordered, numbered update stream; a subscribing window gets a snapshot carrying its number, drops updates at or below it, and asks for a new snapshot on a gap.
- **Cards**: one status card per task with its workers as lines inside (sub-question, state, latest step); one asking card in full at a time, the others in an "Also waiting" row, naming the agent and task from core's record, never from agent-written text; the deep plan card; replaced answers faded, collapsed, labelled "replaced" and kept; the memory-proposal card, reserved until memory exists. Plan cards and memory proposals wait their turn like asking cards.
- **Task events**, raised by code: task started (with the goal line and depth); plan shown and whether it waits for "go"; worker started (its sub-question); worker finished or incomplete; writing started; done check running; done or incomplete. They join the update stream and the snapshot.
- **Card-targeted voice**: the renderer reports the card under the pointer; main takes the latest at key-down. The card under the pointer wins over the item just asked about; words to a task's card go to that task, except an answer to its asking card, which code binds by id. The user never talks to a worker, and the renderer never picks the target.
- **Full step log**: not in the snapshot or in main's memory. On opening a card the renderer asks main, main asks the engine; the reply carries a position, older steps come in pages (most recent first), later steps are added live while the card stays open, and a reopen starts afresh. Progress is combined per agent at most once per second, a change of state goes at once, and an update from an older run or goal version is dropped. How long the log and the notice list are kept, and the page size, are set at build.

### Persistence, recovery and the separate engine

- **SQLite** through Node's built-in `node:sqlite` (or a package, asked first), opened only by the engine; built-in modules are imported with the `node:` prefix, and `npm run package` is proved with a one-file `node:sqlite` import before database code. Every step and the chat history are saved; conversation storage stays apart from execution. A plug adds no tables; it writes rows in the core's tables.
- **Save before acting**: a tool-call step and its state are written before the tool runs; each step's writes are one transaction; dispatch intent and the cost reservation are journaled before every paid request.
- **Crash resume**: a paid call or a tool with effects whose outcome is unknown is shown as uncertain and never repeated by itself; a read-only step is re-run; committed results are restored without repeating calls; after 3 crashes in a row a task is stopped and the user told.
- **The engine as a `utilityProcess`**, swapped in behind V1's port: started with `utilityProcess.fork`, keys passed through an explicit `env`, the database path and results folder as fork arguments, `execArgv: ["--no-warnings"]`, a second webpack entry (`entry: { index, engine }` with `output.filename: "[name].js"`), the engine allowed `DatabaseSync` by a lint override. It holds a database lock the OS releases on exit (an advisory file lock held open, or SQLite's own locking with one connection), never a plain lock file, and a lock is never removed because a start timed out; a second engine refuses to open the database. The engine ends when main ends; if it survives main, it ends itself when its link to main closes.
- **Lifecycle**: ready means recovery, stop reconciliation and state restore are done (about 20 s); a fork that fails or never reports ready counts as a failed start. A heartbeat about every 5 s with one probe after 3 missed beats, paused across machine sleep. At most 5 restarts in about 5 minutes.
- **Forced end**: when "stopping" does not come in about 3 s, main asks the process to end, waits for its exit, forces it, and starts a new engine only after the old one has exited. It is recorded as a stop by the system, not a crash. The new engine resumes nothing until main has handed it the stop and it has saved it; other tasks' in-flight steps become uncertain and resume from SQLite.
- **Main-to-engine messages** carry an id; the engine saves the effect and the id in one transaction and then acknowledges. Main re-sends unacknowledged messages after a restart; repeats are ignored or get their first outcome. Control messages go before queued work, saved stops before held answers; a message from an older engine instance is refused; main's queue during an outage is bounded, stops first.
- **Engine restart**: main says "The agents are restarting." and cards show "restarting"; an answer given meanwhile is held against the same id. A pending question or approval that comes back unchanged is raised again under the same id, prefixed "From before the restart: ..."; a changed one refuses the held answer. After the restart limit main voids every open card with the reason and says "The agents stopped; see the screen." A task spoken before ready is held with "agents starting"; past the deadline Baymax says "The agents couldn't start; see the screen."
- **Resumed work**: the restarted coordinator is woken once with a "restarted" event listing its uncertain steps; a worker's completion or question is saved before it is published and consumed by id, so a lost event is replayed once; each resumed task is marked "resumed after a restart" with its stop control.
- **Lost-stop window, accepted**: if main dies between a forced end and the stop hand-over, the stop is lost; the "resumed after a restart" mark covers it. A main crash ends the app, which resumes from SQLite on the next start.
- **Storage failure**: a failed save is retried once only for busy or locked. A persistent error (disk full, read-only, I/O) pauses new paid and tool steps and main says "I can't save work right now; new work is paused, see the screen." A paid call that succeeded but could not be saved is uncertain and keeps its reservation. If the report file cannot be written, the report text stays in SQLite and shows as a card, incomplete, with "The notes for {task} are saved, but I couldn't write the report." A busy, locked, permission or schema error is shown as such; only a real corruption code (`SQLITE_CORRUPT`, `SQLITE_NOTADB`) offers "start fresh" (the old file renamed aside) or "keep and fix later"; nothing is deleted.
- **Machine sleep**: in-flight model calls count as provider errors, a paid web call is not retried, the voice sockets reconnect, the heartbeat resumes with grace, task clocks exclude the sleep, and one notice says Baymax paused if a task was running.
- Runtime checks before this is built: `node:sqlite` inside a `utilityProcess` and its lock on crash and kill; stop time over the message channel; the engine ending when main is killed; forking from the packaged app with asar and fuses on.

### Cost ledger and retry owner

- **Ledger**: one task-wide ledger covers every paid call. Before each call the engine reserves its estimated cost (a conservative upper bound of input, cache and output tokens) and starts the call only if it fits; actual usage settles it; a call with an unknown outcome keeps its reservation. App-wide: one intake and one talker call in flight (a newer utterance cancels the older call where the SDK allows), and a session budget of about $1 for calls that belong to no task. Output-token ceilings beyond V1's: talker 256, coordinator 2,048, plan 4,096, writer 8,192. A reserve is kept back for the coordinator, writer and done check.
- **Run time** counts awake time while any of the task's work is active (calls, tools, backoff); it pauses while the whole task waits for the user or the machine sleeps and survives a restart.
- **One retry owner, our loop**: the SDK's retries off. A call is retried on a rate limit (honouring `retry-after`), a server error, or a connection failure before the request was written (`ENOTFOUND`, `ECONNREFUSED`, TLS); a reset, timeout or stalled stream after sending is not retried. Never on auth, billing or invalid-request errors, except prompt-too-long, which triggers compaction and one retry; never during or after a stop. Every attempt counts toward the limits; a stop cancels a backoff sleep; a retried request never repeats tools already dispatched; every call has an absolute and a stalled-stream deadline, capped by the task's remaining run time.
- **Paid web calls**: one retry only on a server error or a connection failure before the request left, with the budget reserved again; none on a timeout, a drop after sending, credits out or an auth error.

| Role | Attempts, wall cap | When used up |
| --- | --- | --- |
| Talker label | 2 (second on Sonnet 5.5), about 8 s | "I can't reach my models right now; use the screen." |
| Intake check | 2, about 15 s | The thinking card shows a retryable failure; the words stay on screen |
| Coordinator | 3 | Task incomplete, error kind |
| Worker step | 3, about 2 minutes per step | The worker returns incomplete |
| Deep plan, deep report | 2, about 3 minutes | Plan: incomplete; report: notes and sources shown |
| Done check judge | 2, about 1 minute | Incomplete, error kind, never done |

### Compaction

- First the deterministic prune: old tool outputs pruned; the goal, check list, refusals, pending bindings and todo note kept; never a pending tool call, question or plan. Later the middle summarised by a model, marked "background only, not a new instruction". Prompt-too-long after the prune ends the step incomplete, error kind.

### Memory

- Baymax builds its own memory and asks before it remembers. A proposed memory needs the user's yes and applies from the next task on; each entry records where and when it came from. A remembered preference guides the work but never approves a risky step.
- Saved answers are never reused as preferences without the user's yes.
- Learning in the background after a task: a helper re-reads the finished conversation and proposes skills and memories, pausing for a related task.
- Session recovery is separate from memory. What is deleted and what may be reused after a "no" is defined when memory is built, after its own research.

### Other V2 parts

- **Jev** (TypeSafe AI) picks the worker's model at `pickWorkerModel`, and later shortlists tools and gives action hints; its PR keeps the check of about 20 task briefs (its pick against the expected pick, its latency, a timeout, and Sonnet 5.5 when it fails or is unsure).
- **Windows** through the split in `src/main/platform.ts`; permissions, packaging and audio still need work.
- **The user's own keys** with a Settings screen and `safeStorage`.
- **Model-written progress summaries.**
