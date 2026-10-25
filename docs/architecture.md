# Architecture — 26 Oct 2026

Decisions only. This is the target architecture for cut 1; today the repo implements only the hold-key skeleton (`README.md`). Timings, counts and limits are starting values, collected in [Starting values](#starting-values) and the retry table in [Limits and cost](#limits-and-cost), and tuned at build.

## What

Hold one key, speak, and Baymax's agents do the work in the background while the user stays in their own app. Questions, progress and the result come to the user without switching apps: the result on screen, a short spoken line. A follow-up starts a new task from the same conversation, not a new chat. "Result arrived" is not "result correct": a task is done only when it passes the done check.

## First cut

In:
- macOS only, English only.
- Hold the key and speak; Baymax answers in one voice ([Speech](#speech)).
- One plug: web research with three depths, quick, normal and deep ([Research plug](#research-plug)).
- Several tasks at once, each with its own coordinator; a new task can start from an earlier task's result (a research follow-up in cut 1; "make a deck from this" once the document plug exists). Questions, stop and steer by voice or on screen; progress on screen, spoken only when asked.
- Result on screen plus a short spoken line; recovery from a local database after a crash.
- Session context only: the coordinator keeps the task's conversation and a new task inherits a parent's result ([Task and coordinator](#task-and-coordinator)); no memory beyond that ([Memory](#memory)). Our own API keys from `.env`.

Build order (the delivery fallback): the first working slice is one active task with one worker and queued new tasks, built with task ids, goal versions, worker briefs and result events as designed, so that several workers and several tasks are switched on afterwards.

### Out of Scope

Not in cut 1; each waits for a later version.
- Windows. The Mac/Windows split in `src/main/platform.ts` stays as the upgrade path.
- Languages other than English, Hindi and Hinglish included.
- Open-mic (always listening); speech-to-speech models (OpenAI Realtime, Gemini Live) and managed voice agents (Deepgram Voice Agent, ElevenLabs Agents).
- Cloud agents (VMs, Manus / Devin style; cut 1 runs agents on the laptop), the Claude Agent SDK as a coding worker, and a process per worker for crash isolation.
- The user's own keys, a Settings screen and `safeStorage`; the user's own Claude Code / Codex login (Conductor-style route); OpenRouter and model providers other than Anthropic.
- Cost display to the user. Cost is tracked for the team only ([Limits and cost](#limits-and-cost)).
- Plugs beyond research; document creation is the next, and rollback of the user's files (copy before change) comes with the first plug that edits them. A request outside research is said back as not supported in this version, and no task starts.
- Model-written progress summaries.
- Social data APIs (X, Reddit, LinkedIn) and fetching x.com or linkedin.com pages; other search providers (Perplexity, Brave, Jina, Parallel, Google Gemini); a separate deep-research mode on Perplexity or Gemini.
- Memory beyond session context: the memory-proposal card's producer, saved preferences, the background learning helper (skills and memories proposed after a task, and its pause rule for related tasks), long-term extraction and retrieval, lasting approval rules such as "always allow". The card kind stays reserved in the [UI contract](#ui-contract); the [direction](#memory) stays.
- Approval cards and the uncertain-action card: no cut 1 tool acts outside ([Approvals and questions](#approvals-and-questions)).
- Jev (TypeSafe AI): cut 1 picks the worker's model in code ([Stack](#stack)); Jev's model pick, tool shortlisting and action hints come later, and the PR that adds Jev keeps the decided check (about 20 task briefs, Jev's pick against the expected pick, its latency from the app, a timeout, and Sonnet 5.5 when it fails or is unsure).
- Compaction by model summary and the progress helper's model call ([Workers](#workers), [Live log and progress](#live-log-and-progress)).
- Typed input. When voice is down, cut 1 works through cards, clicks and the stop controls.
- Connectors (Gmail, Calendar and others), camera / live video, explainers / diagrams, phone calls.

## Pipeline

```
renderer                  main                                     engine (utilityProcess)
mic frames  --IPC-->  Flux STT -> talker (Haiku 5.5)   --msg-->  intake check -> one coordinator per task
                      code: exact "stop", yes / stop,            -> workers -> writer -> done check
                      answers bound by id
playback    <--IPC--  Flux TTS <- speech queue          <--msg--  events, questions, results
cards       <--IPC--  shown state, numbered updates
```

- The voice route is our own cascade: Deepgram Flux STT, Claude, Deepgram Flux TTS. Approval, stop, steer and the conversation stay in Baymax code.
- The renderer captures the mic (`getUserMedia` + AudioWorklet, 16 kHz PCM frames over IPC to main) and plays speech (Web Audio), because Chrome's echo canceller only removes audio Chrome itself plays (Electron issue #47043). Frames use typed IPC; a `MessagePort` only if a measurement shows delay.
- The talker runs in main next to the voice connections. It gives the quick spoken line and labels what the user said; the labels, a starting set measured in the voice checks: yes, no (with the reason), stop, answer (with the chosen option or the "something else" text), go on, progress, correction, new task, unclear. Code binds the first six; the rest go to the intake check. The talker never decides what a task means.
- A yes, no, stop, answer, go on or progress label goes to our code, which picks the target and checks authority. Everything else goes to the intake check, the first call of the coordinator role, in the engine ([Task and coordinator](#task-and-coordinator)).
- Nothing acts before the full final utterance after key release, so "delete it, no wait, stop" never acts on its first half.

## Stack

| Part | Choice |
| --- | --- |
| STT | Deepgram Flux (swap: Cartesia Ink-2) |
| TTS | Deepgram Flux TTS, one voice (swap: ElevenLabs). Fallback if our key has no Flux TTS: Aura-2 with the reduced contract in [Speech](#speech), [Checks](#checks-before-the-engine-is-built) |
| Talker | Claude Haiku 5.5 |
| Intake check and coordinator | Claude Sonnet 5.5 |
| Deep research plan and deep report | Claude Opus 5.5 (Fable 5.1 for the report only if it wins the one-report test) |
| Workers | Haiku 5.5 for quick, Sonnet 5.5 otherwise, picked in code by `pickWorkerModel(depth, brief)`; that function is the seam Jev (TypeSafe AI) plugs into later |
| Done check judge | Set at build; a small model |
| Web | One `web` tool owned by Baymax; behind it Exa or Tavily for search and Firecrawl for JavaScript pages and PDFs, picked by the live test |
| Agent runtime | Our own loop and controller on the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), in the engine process |
| Database | SQLite, opened only by the engine ([Platform](#platform)) |
| Keys | Our own keys for the demo, from `.env` ([Processes and ownership](#processes-and-ownership)) |

- Claude only. Changing a model is one field per request.
- Routing is a fixed model per role plus the per-task pick of the worker's model; no model is chosen per message. The pick never decides yes or stop and is not the talker, so a wrong pick costs money, speed or quality, never safety.
- No automatic switch to another provider when one fails. The role models, the worker pick and the talker's one Sonnet 5.5 retry on a failed label call are not provider failover.
- No framework: our own pipeline and agent loop inside the app.

## Processes and ownership

| Process | Runs | Owns |
| --- | --- | --- |
| Main | Hold-key, windows, IPC with the renderer, Flux STT and TTS connections, the speech queue, the talker, starting / watching / stopping the engine | The shown state: what the screen and the talker need at once (agent states, pending items, recent turns, the notice list), fed by engine messages and rebuilt from the engine when it starts |
| Engine (one Electron `utilityProcess`) | Intake check, coordinators, workers, writer, done check, progress counts, the worker model pick, SQLite | The saved run state |
| Renderer | Cards and state, mic capture, playback | Nothing; it shows what main sends |

- Main does no blocking work: no synchronous SQLite, nothing CPU-heavy.
- Only the engine opens the database. What happens in main (the user's words, the talker's lines, the talker's calls and their cost) goes to the engine as "save this" messages, held by main while the engine restarts.
- Main reads `.env` at start and keeps the Deepgram and Anthropic keys. It passes the engine only the keys it needs (Anthropic, web tools) through the `env` option of `utilityProcess.fork`, set explicitly because the default is main's whole environment. Keys are removed from the global environment before any window opens. The renderer gets no key and makes no network calls.
- One engine, not one per worker: the research plug starts no child processes, an in-process stop is fast (spike: 60 of 60 live stops, at most 27 ms offline), and a crash is covered by [recovery](#persistence-and-recovery).
- The engine ends when main ends; if it survives main, it ends itself when its link to main closes.
- One app instance: Electron's single-instance lock makes a second instance focus the first and exit. The engine holds a lock on the database that the operating system releases when the process ends (an advisory file lock held open, or SQLite's own locking with one connection), never a plain lock file that survives a crash; a lock is never removed because a start timed out. A second engine refuses to open the database.

## Agent engine

### Core and plugs

- One core, built once and shared by every kind of work, plus one plug per kind of work.
- Core parts: the coordinator's loop, the worker loop, the goal and check list, the todo note, approval / stop / steer, the live log, the progress counts, the done check, splitting and the single writer, the cost ledger, checkpoint and resume, the deterministic prune, the worker model pick, and SQLite. The list grows only by an agreed shared part. Cut 1 builds the parts the research plug needs.
- A plug is its tools (each with its [declaration](#approvals-and-questions)), its prompts (including the coordinator's prompt for that kind of work) and its done condition. A plug adds no SQLite tables; it writes rows in the core's tables. A new kind of work adds a plug folder and leaves the core alone.
- No `Plug` interface until a second plug exists.

### Task and coordinator

- **One coordinator per task**: its own Sonnet 5.5 conversation in the engine. It starts with the task and ends after the done check or a stop; nothing idles between tasks. A second task gets its own coordinator. It wakes for a user message for that task or a worker's question, result, incomplete or death, and sleeps at no cost between calls. The user still sees one Baymax: the talker and our code are the front, tasks are cards. The intake check and the coordinators run in the engine; main sends the user's words with the screen context it holds (pending item ids, the card under the pointer, the cut answer).
- **Handled by code, no intake call**: the exact "stop" phrases ([Controls](#controls)); a yes or stop label; an answer or a "no" with its reason to the question just asked or to the asking card under the pointer, bound to that question's id; "go on" after a key cut, which resumes the cut speech; a progress question, answered from the counts. None becomes a steer or a new task.
- **The intake check**: everything else the talker labels (the labels are hints) goes to one fresh Sonnet 5.5 call. It gets the user's exact words, a short record of the recent conversation, the running and recently finished tasks with their goal lines, and, where present, the item on screen the words may refer to, the pending question or plan, and the answer that was cut. In that one call it settles: (a) which task the words belong to (a new task, possibly with a parent; a follow-up or steer of a running task; a reopen of a finished one); (b) the research depth; (c) whether a clarifying question is needed, only when missing intent, constraints or the thing referred to would change the work; (d) the say-back line. A card under the pointer or the held key fixes the target before any model is asked; the intake check then only reads the words for that task.
- **Say-back = goal line**: one line on what the coordinator understood, with the task, its limits and the depth ("Dell laptops up to $1,000, normal research"). It is feedback, not an approval gate: a clear goal starts at once and the user corrects it in a word. A typed answer or a confidence score is not proof of understanding; the say-back is the check. A "yes" handled by code gets no say-back.
- **Outcomes**: a new task starts its coordinator seeded with the intake's understanding, depth and say-back. Words for a running task wake its coordinator, or reach it under queue / send now if a call is in progress; the coordinator raises the goal version and steers or stops the affected workers. A reopen continues the finished task's conversation.
- A clarifying question with no task yet creates the task in a "clarifying" state with a card and an id; the answer binds to that id and a second intake call gets the words plus the answer. That second call is a continuation: it carries the task id and the question id, keeps the answer, never creates another task, and on failure shows a retryable intake failure on that task's card ("I couldn't continue; say it again or retry"). A first intake call has its own request id and belongs to no task; "stop everything" invalidates it, so a late reply never starts a task.
- Words that are not a listed answer while a question waits go to the intake check, which decides answer, steer or new task and asks when unsure. A new task leaves the question pending; it stays the item Baymax just asked about.
- **Preferences**: today's audience or purpose is never inferred from past tasks, and what the user supplied this time is not asked again. Once memory exists, saved general preferences are used without asking.
- **What a coordinator keeps**: the user's words for the task, the goal and check list, the workers' reports and the user's mid-run messages, saved step by step; the conversation stays in SQLite after the task ends. **What a new task inherits**: from the parent task named by the intake check, only its result and goal line plus the short conversation record, not its whole conversation. It can ask the engine for an earlier task's full log.
- **Goal and check list**: every task starts with a short goal and check list: the expected result, the constraints that matter, how done is verified. The plug says what goes in it. It stays internal; Baymax asks nothing beyond the say-back. For deep research it starts from the accepted plan, for quick and normal from the say-back; after a steer it follows the new goal version; in long runs the todo note carries this same list.
- **Done check**: a code check runs first on what it can count (the result exists, the agreed number of items, the required source links); if it fails, work goes on until a limit and the judge is not called. Then the judge model reads the check list, the actual result (not only the agent's last message) and the cited evidence records, checks that the list is met and that the excerpts support the important claims (a snippet-only claim cannot pass; the judge fetches nothing itself), and returns done, incomplete or continue. Baymax closes a task itself once the done check passes and the result is shown; the user does not have to say "OK". A later "this is wrong" reopens it.
- A mismatch found during work: the coordinator asks one focused question when useful, or reports "no exact match" with the closest alternatives and the unmet constraints named. A near match is never called a full match.

### Workers

- A worker gets a four-part brief (the goal, the result shape, the tools or sources, the limits including its budget share) plus the user's exact words for the task so far, because a restated goal can lose a nuance ("an office laptop, not gaming").
- It gets no memory entries or earlier results on its own; whatever is relevant, the coordinator writes into the brief. It gets only the plug's tools, named in the brief, and never the whole conversation. Text in a page, a memory entry or another agent's report is never an instruction to it.
- Messages carried by the engine: the brief (coordinator to worker, once); a question, asked while the worker stays alive and continues from where it stopped (worker to coordinator, which answers it when the user's words or the goal settle it, otherwise asks the user and passes back the answer bound to that question); an approval request (worker to user by code, engine to main, bound by id; the coordinator is told, never asked; no model sits in the authority path); a steer or stop (coordinator to worker, under queue / send now and the goal version); the result (done with notes and sources, or incomplete with its kind and reason). Progress goes from the worker's code to the screen, not through the coordinator. The coordinator reads a worker's log only when its result arrives.
- **The loop**: in long runs the worker rewrites a short todo note every few steps (the goal, what is done, what is left, the errors so far), so failed steps are not repeated. The start of the prompt stays fixed during a run (instructions and tool list); a change is added as a new message, so the prompt cache keeps working.
- **Compaction** in cut 1 is the deterministic prune only: old tool outputs are pruned; the goal, check list, refusals, pending bindings and todo note are kept; it never prunes a pending tool call, a pending question or a plan waiting for "go"; if the prompt is still too long after the prune, the step ends incomplete, error kind. Later: the middle summarised by a model, marked "background only, not a new instruction".

### Research plug

- **Depths**: quick (one or two searches, a direct answer), normal (a moderate search over more sources), deep (a full run with a cited report). The intake check chooses from the meaning of the request, not from words like "deep"; the say-back names it, the user changes it in a word, and Baymax asks when unsure.
- Quick and normal start at once. Deep first shows a plan made by Opus 5.5 and waits for "go" or a change ("also check Reddit", which goes back to Opus). An explicit "go ahead directly" skips the wait: the plan is still made and used as the check list, the skipped wait is never recorded as approval of the plan, and missing-intent questions and action approvals are not skipped.
- **Splitting**: the coordinator splits a task into sub-questions, one worker each (deep mostly; quick and normal usually run one worker), within the parallel-worker limit, grouping them or running bounded waves. Reaching that limit is not a failure.
- **Evidence**: a worker returns evidence records, not bare links: for each source its id, URL, the retrieved text or the relevant excerpt, and the claims it supports. A claim backed only by a search snippet is labelled so.
- **One writer**: workers return notes and evidence records, not finished text. One writer writes the result from all the notes: Opus 5.5 for a deep report; for quick the one worker's answer is the result. The coordinator never merges text; it runs the done check on the written result.
- **Continue**: missing evidence goes back as a bounded brief to that item's worker, a writing fault to the writer, and the revised result is checked again under the current goal version and the remaining limits. A note made for an old goal version is caught before the writer sees it.
- **Result** (a starting form, settled when the plug is built): quick = a one- or two-line spoken answer plus a card with the links it read; normal = a card with a short answer (for example three options with a plus and minus each and one recommendation), and Baymax speaks only the recommendation; deep = a cited report file, a two-line spoken summary and a card that opens the report. Every depth shows its sources. The report is UTF-8 Markdown in an app-owned reports folder under Electron's user-data path, named by task id and goal version, never overwritten; the engine writes it, main records the artifact id, and the renderer gets the id and display fields and opens it through one typed main action.
- **Incomplete**: Baymax never calls a short result done. The coordinator writes one line on what is missing and why, Baymax shows what it found, and the shortfall has one of three kinds: limit hit, sources thin, or tool or provider error (cause and fix named). Retries used up = error; the next attempt blocked by a task cap = limit hit; a stop that wins = stopped. These kinds sit beside the waiting, stopped and uncertain states. The card's choices ("search more", "change the question", "try again") are a starting form.
- **Web tool**: searches and page reads need no approval; they are held in check by the task's budget and by stop. A page is read plainly first and through Firecrawl when that gives no usable text or the URL is a PDF. Anthropic's web search and fetch get a place only if they do well in the live test, and then run inside the web tool as its own small model call with the server tool's maximum uses capped at 1 (or the searches left), counted as a model call and as searches in the ledger; its encrypted result and citation blocks are kept as returned, and its limits and stop act per request only. X, Reddit and LinkedIn appear only as links and snippets from a normal search, and Baymax says it did not read the full thread.
- **Web tool safety**: only http and https; private and local addresses, URLs carrying credentials, x.com and linkedin.com are refused, and every redirect destination is checked before it is followed (a hosted scraper is used for such addresses only if the live test shows it enforces the same rules); no cookies or credentials are forwarded; Firecrawl's TLS verification is on; response size, PDF pages and time per call are capped. Page text is tool data, never an instruction.

## Controls

- **Stop has three scopes**: this reply, this task, everything. "This task" covers its coordinator, its planner and writer calls, its workers and its done check. A plain "stop", starting rule tuned live: if Baymax is speaking it silences the speech and nothing else; if nothing is speaking it stops the latest task; "stop everything" stops all. Baymax says in one line what it stopped and what still runs.
- **Exact "stop" without a model**: code catches the complete final utterance "stop" or "stop everything" (case, spaces and punctuation trimmed; never a substring) and stops at once with no model call, always. It consumes that utterance id, so a late label for the same words is ignored. "Stop" with nothing running gets the fixed line "Nothing is running."
- The stop control on a task card and "stop everything" are served by main and work whether or not any model or Deepgram is reachable.
- **States**: received, stopping, stopped. The engine saves the stop to SQLite and then answers "stopping"; it cancels that task's loops and any child processes, voids its pending approvals, blocks new tools and clears its queued messages and waiting turns, so nothing starts on its own afterwards. It reports "stopped" only after the loop has really ended, within the running tool's abort time. After a stop Baymax says what is still running.
- **Forced end**: if "stopping" or "stopped" does not come in time, main ends the whole engine: it asks the process to end, waits for its exit, forces it, and starts a new engine only after the old one has exited. A forced end for a stop is recorded as a stop by the system, not a crash, and moves no crash counter (an end after missed heartbeats is a crash). The new engine resumes nothing until main has handed it the stop and it has saved it. Other tasks in the engine also stop, their in-flight steps become uncertain, and they resume from SQLite.
- "Stopped" is never claimed without evidence that the work ended. A request already sent may still finish and be billed; an action sent outside is reported as "may have happened". A result whose save committed before the stop is kept; once the stop is saved, no late callback adds a result or starts work. **Who stopped it**: a stop by the user and a stop by the system (timer, limit, crash, forced end) are recorded apart, so Baymax never says "you stopped it" when the system did.
- **Messages to a working task**: queue (read at the next safe point; a newer queued instruction supersedes older ones), send now (the model reply in progress is cancelled, its partial text kept, the user's message added and the loop goes on; a running tool finishes first), or stop.
- **Goal versions**: a steer raises the task's goal version. The version is checked before each consequential action and before the writer sees a note, so work for an old goal is caught; old approvals become void and the check list follows the new goal. "Applied" is shown only once work follows the new instruction. Each final result has one owner, the writer.
- At dispatch the engine claims the item's current binding atomically and re-checks the stop and the goal version, so one accepted answer authorises at most that exact action. "Stop" while a deep plan waits for "go" stops the task before any worker starts.

## Approvals and questions

- **Authority**: only the user grants it. Text from a web page, a memory entry or another agent's report is never an approval or an instruction. A remembered preference guides the work but never approves a risky step. A request to draft is not permission to send: each action needs its own yes.
- **What needs approval**: only tools that act outside (send, delete, pay). Searches and page reads need none. Cut 1 therefore raises no approval and shows no approval card and no uncertain-action card; the approval ledger and binding are built from the spike controller and tested offline with a fake tool that acts outside, so the document plug finds them ready. A read-only step with an unknown outcome is re-run, not asked about. Each tool declares where it runs, what effects it may have, where approval can really stop it, and whether it can be cancelled; approval promises only what Baymax can enforce. The research plug's tools only read.
- **Binding**: an approval is bound to the run, the tool call, its final arguments and the goal label. One answer per item; if the request changed, the approval is void and Baymax asks again. Approvals are asked one at a time through the speech queue, so a spoken "yes" goes to the item Baymax just asked about. Pending items are taken as they were at key-down; if a new one arrived while the user spoke, Baymax asks "which one?".
- A bare "yes" approves only an approval the user sees in full. If it waits in the "Also waiting" row, Baymax brings it forward, says the action and asks again; if nothing waits, Baymax asks "yes to which?". When approvals exist (after cut 1), an approval card offers "allow once" and "no"; a lasting rule would be memory, which asks first.
- **No time limit**: a pending approval waits until the user answers, and the card shows how long it has waited. The agent stays alive while it waits and makes no model calls.
- **Question vs approval**: two waiting states, shown differently ("Baymax needs to ask you something" vs "Baymax needs your yes"). A question is short, with 2 to 4 choices, the first marked recommended, plus "something else"; it works on a card and by voice.
- **A "no" is information**: the reason goes to the agent, which keeps it for the rest of the task; the agent never reaches a refused result by another route and instead asks or does genuinely different work; after several refusals in a row it stops guessing and asks what the user wants. A refusal is not carried to later tasks.

## Live log and progress

- **From code, not a model**: a tool call started, with a label built from the tool's own arguments ("search: best laptops under $1,000", "reading rtings.com"), never from page text; a step finished, done or failed; a note added; the todo note changed (done and left); an error and whether the worker moved on; a change of state. A worker finishing is not the task being done.
- The engine sends the screen only fixed display fields, with keys and credentials removed; cost records never reach the screen.
- **Status card**: one line for the latest step plus a few counts (sources read, todo done of total, active time). The full log shows when the card is opened. A step shows as done only once its result is saved; otherwise it shows as uncertain.
- **Rate**: a change of state goes at once and first; other progress is combined per agent. Main numbers updates after combining. An update from an older run or goal version is dropped, so a late "running" never shows after "stopped".
- **Full log**: not in the snapshot or in main's memory. On opening a card the renderer asks main, main asks the engine; the reply carries a position, older steps come in pages (most recent first), and later steps are added live while the card stays open. A reopen or reload starts afresh; late replies are dropped.
- **"How far along?"**: answered by code from the current state and goal version, the todo note and the counts, so the worker is never disturbed. A count is said with what it counts ("6 of the 10 planned sources read"), never as a percentage; a time left only when there is a measured basis. Later: a separate read-only helper model that reads the log, cannot run tools and counts toward the task.

## Speech

- **One voice**: models write the words, Flux TTS speaks them. The coordinator starts at once; the talker's quick line is spoken only when the coordinator's line is not ready within a short wait. The quick line makes no time promise ("let me check", not "one second") and never claims progress.
- **Hold-key only**: Baymax listens only while the key is held.
- **One speech queue in main**, in this order: (1) approval or question, (2) stuck or failed, (3) done, (4) progress (screen only unless the user asks). Sub-agents never speak to the user; the coordinator chooses per notice to speak and show a card, or show a card only.
- Nothing is spoken while the key is held. A new notice never interrupts a line already being spoken; only the user's key does; several waiting notices become one line ("two tasks done, one needs your OK"); spoken updates name the work ("the laptop research is done"). An approval or failure during speech gives only a short sound and is spoken after.
- **Key press while Baymax speaks**: the speech stops at once, running work continues, and the full answer stays on screen. The next words decide: a correction (answered again, knowing how much was heard from Flux TTS `text_spoken`), a new task, or "go on". If unclear, Baymax asks. Pausing the speech, or speaking on while the user talks, is not used.
- **TTS fallback (Aura-2)**: the local playback stop and stale-frame rejection stay; a notice counts as heard on the renderer's playback-finished report alone; after an interruption the heard portion is unknown and the whole notice is replayed on "go on" or "what did I miss"; continuing from the cut word is Flux-only until validated.
- **"What did I miss"**: main holds one notice list, saved through the engine, each line naming the work. Baymax speaks the notices not yet heard or opened. Heard = played to the end without a key cut, confirmed by the renderer's playback-finished report plus `text_spoken`; opened = its card opened. If nothing is new, Baymax says so and offers the last few.

## UI contract

- **Received, then applied**: every user action shows two steps, and its card stays until a final outcome. Received: for a click once main has taken the item's id, for voice once the words are labelled and the target picked. Applied: for a yes, the approved tool has started; for a no, an answer, a queued message or a steer, the engine has saved the input and the worker's next loop step has started (for a steer, under the new goal version). Stop shows received, stopping, stopped. An action can also end refused, superseded, failed or uncertain.
- **Ids and refusal**: every card, pending item and user action has its own id; the UI sends the item's id and the action's id. Core accepts one answer per item: a stale id or a second answer is refused, and a repeat of the same action id gets the first outcome back. Main refuses at once from its pending items; the engine refuses on the binding. A refusal shows its reason (question changed, already answered, agent stopped, agent ended unexpectedly, goal changed). A click never disappears silently.
- **Snapshot plus numbered updates**: main keeps one ordered, numbered update stream. A subscribing window first gets a full snapshot carrying its number: agents and states, pending items with waiting time, actions in flight, answers and results (replaced ones marked), uncertain actions, unseen notices, each task's current line and counts. Updates at or below that number are dropped; a gap makes the UI ask for a new snapshot. After an engine restart main sends every window a fresh snapshot.
- **Cards**: one status card per task, with its workers as lines inside when opened (sub-question, state, latest step). One asking card (approval or question) is shown in full at a time, the others in an "Also waiting" row; it names the agent and task from core's own record, never from agent-written text. Other kinds: the deep plan card waiting for "go", the result card and the incomplete card. Reserved for later, in the contract but not built in cut 1: the approval card, the uncertain-action card and the memory proposal (plan cards and memory proposals wait their turn like asking cards). Placement is the UI team's call.
- **Task events**, raised by code: task started (with the goal line and depth); plan shown and whether it waits for "go"; worker started (its sub-question); worker finished or incomplete; writing started; done check running; done or incomplete. They join the update stream and the snapshot.
- **Playback reports**: the renderer reports playback position and playback finished for each spoken line id; main keeps the session-wide offset and sends it with Flux TTS `Interrupt`, which is how `text_spoken` is known.
- **Card-targeted voice**: the renderer reports which card is under the pointer (an id or none) through one typed action; main takes the latest at key-down. The card under the pointer wins over the item just asked about. Words to a task's card go to that task's coordinator, except an answer to its asking card, which code binds by id. The user never talks to a worker, and the renderer never picks the target.
- **Replaced answer**: the new answer is shown on top; the old one is faded, collapsed, labelled "replaced" and kept. A result made for an old goal version gets the same mark.
- **Uncertain action** ("may have happened"): "It happened" marks the step done and the task goes on; "Leave it" marks it not done, and the agent goes on without it or asks; "Do it again" is a new approval, accepted only for a live agent under the current goal version.

## Persistence and recovery

- Every step of a run and the chat history are saved to a local SQLite database. A waiting agent stays alive and continues from where it is; after an app restart it resumes from SQLite. Session recovery is separate from opt-in memory.
- **Save before acting**: a tool-call step and its state (approved, running, done) are written before the tool runs; if that save fails, the tool does not run. Each step's writes are one transaction. A result counts once its save is committed. A result file is written to a temporary file in the same folder and renamed in one step.
- **Crash resume**: a paid model call or a tool with effects whose outcome is unknown is shown as uncertain and never repeated by itself ("the email may have been sent, please check"); a read-only step (its declaration says effects: none) is simply re-run. An answer that was ready but not delivered is delivered once; a turn with no answer is re-run once only when the journal proves that no paid request and no tool action was dispatched for it (dispatch intent and the cost reservation are journaled before every paid request); a dispatched call whose result was not saved stays uncertain, keeps its reservation and waits for the user (the uncertain-action card for an action, "retry" on the task card for a pure model call). Committed results are restored without repeating their calls. After too many crashes in a row for one task, Baymax stops that task and tells the user; a crash counts for every task that was running. The engine keeps the per-task crash count in SQLite; main keeps the count of engine restarts.
- **Engine restart**: main sees the exit at once, speaks "The agents are restarting.", and starts a new engine; cards show "restarting". An answer given meanwhile is held by main against the same id. A pending question or approval that comes back unchanged from SQLite is raised again under the same id, prefixed "From before the restart: ..."; a changed one refuses the held answer. After the restart limit, main stops restarting, voids every open card with the reason and says "The agents stopped; see the screen.", and the screen names the cause and fix.
- The restarted coordinator is woken once with a "restarted" event listing its uncertain steps; it does not re-brief a worker whose brief is saved, and workers resume from their saved notes. A worker's completion or question is saved before it is published and consumed by id, so a lost event is replayed once. After any unclean end, each resumed task is marked "resumed after a restart" with its stop control.
- **Engine start**: ready means recovery, stop reconciliation and state restore are done. A fork that fails or never reports ready in time counts as a failed start under the restart counter. A task spoken before then is held with "agents starting" on screen, and if the deadline passes Baymax says "The agents couldn't start; see the screen."; until ready, main speaks only fixed status and control lines and the caught "stop" works. A busy, locked, permission or schema error is shown as such. Only a real corruption code (`SQLITE_CORRUPT`, `SQLITE_NOTADB`) offers one explicit choice: "start fresh" (the old file renamed aside with a timestamp) or "keep and fix later"; nothing is deleted.
- **Heartbeat**: the engine sends one regularly; the check starts after the first beat and pauses between `powerMonitor` suspend and resume. After missed beats main sends one probe; no answer means the forced end and restart, recorded as a crash by the system. A heartbeat proves the process responds, not that a worker progresses; call deadlines cover that.
- **Main-to-engine messages** ("save this", a stop, a held answer) carry an id. The engine saves the effect and the id in one transaction and then acknowledges (acknowledged = saved, not applied). Main re-sends unacknowledged messages after a restart; repeats are ignored or get their first outcome, so cost records never double. Control messages go before queued work, saved stops are applied before held answers, and a message from an older engine instance is refused. Main's queue during an outage is bounded, stops first.
- **Lost-stop window, accepted**: if main dies between a forced engine end and the stop hand-over, the stop is lost. The "resumed after a restart" mark covers it; there is no second persistence path beside the database. **Main crash**: the app ends and resumes from SQLite on the next start.
- **Worker death in a living engine**: screen only; its line shows "ended unexpectedly" and its open waits are void with that reason. The coordinator restarts it once from its saved notes or ends the task incomplete, error kind. One spoken line per task outcome, never per worker.
- **Machine sleep**: on wake, in-flight model calls count as provider errors under the retry rule, an in-flight paid web call is not retried, the voice sockets reconnect, the heartbeat resumes with grace, task clocks exclude the sleep, and one notice says Baymax paused if a task was running.
- **Storage failure**: a failed save is retried once only for busy or locked. A persistent error (disk full, read-only, I/O) stops new paid and tool steps for every task; running steps end safely and main says "I can't save work right now; new work is paused, see the screen." Affected tasks show as incomplete, error kind, but a terminal state that was not saved is not claimed as committed. A paid call that succeeded but could not be saved is uncertain, never silently repeated, and keeps its reservation until reconciled. If the report file cannot be written, the report text stays in SQLite and shows as a card, incomplete, error kind; the file is written again only when the user asks.

## Limits and cost

- **Cost tracking**: every model call writes its model, input, output and cache tokens and dollar cost to SQLite; at the end of a task the dev log shows its total by model for the team. Cost never reaches the user's screen. To keep it low: workers send short notes, not whole pages; the prompt cache; the cheapest model that keeps the quality at each step.
- **Limits for the app**: at most 3 active tasks (a fourth is queued and the user told); one intake call and one talker label call in flight (a newer utterance cancels the older call where the SDK allows); a session budget of about $1 for calls that belong to no task (talker, intake); output-token ceilings per role (talker 256, intake 1,024, coordinator 2,048, worker 2,048 per step, plan 4,096, writer 8,192, judge 1,024); a reservation uses a conservative upper bound of input, cache and output tokens before dispatch.
- **Limits per task**: dollars, model calls, searches, active run time and parallel workers. At a limit the work stops with incomplete, limit hit. Per-depth values are in [Starting values](#starting-values).
- **Ledger**: one task-wide ledger covers every paid call of the task (coordinator, planner, workers, writer, judge, paid web calls); the intake call belongs to no task. Before each paid call the engine reserves its estimated cost and starts the call only if it fits; actual usage settles it; a call with an unknown outcome keeps its reservation, never counted as zero. A reserve is kept back for the coordinator, writer and done check; the rest is split among the workers through their briefs, and a worker's unused share returns when it ends. Overshoot is at most one in-flight call per active caller.
- A worker that uses up its share ends with what it saved and returns incomplete; the coordinator decides once within the remaining limits. An unmet check-list item makes the task incomplete even with budget left.
- **Run time** counts awake time while any of the task's work is active (calls, tools, backoff). It pauses only while the whole task waits for the user or the machine sleeps, survives a restart, and is the "time so far" on the card.
- **One retry owner, our loop**: the Anthropic SDK's own retries are off, with explicit `maxRetries` and `timeout` per call, and every attempt counts toward the limits. A model call is retried on a rate limit (honouring `retry-after` when it fits the deadline), a server error, or a connection failure before the request left (a DNS failure, a refused connection or a TLS failure before the request was written, such as `ENOTFOUND` or `ECONNREFUSED`), with backoff and jitter; a reset, a timeout or a stalled stream after that counts as sent and is not retried, and its reservation stays. A stop also cancels a backoff sleep.
- A model call is never retried on an auth, billing or invalid-request error (the screen names the key or account and where to fix it), except prompt-too-long, which triggers compaction and one retry; never during or after a stop; never after a timeout or a drop once the request was sent. A retried request never repeats tools already dispatched. Every call has an absolute and a stalled-stream deadline, capped by the task's remaining run time.
- **Paid web calls**: one retry only on a server error or a connection failure before the request left, with the budget reserved again; none on a timeout, a drop after sending, credits out or an auth error.

| Role | Attempts in all, wall cap | When they are used up |
| --- | --- | --- |
| Talker label | 2 (the second on Sonnet 5.5), about 4 s per call, about 8 s in all | "I can't reach my models right now; use the screen." The screen shows the transcript, the cause and the stop control |
| Intake check | 2, about 15 s | First call: no task is created; "I couldn't start that; say it again." The words stay on screen. Continuation after a clarifying question: the task and its answer are kept and the task card shows a retryable failure |
| Coordinator | 3 | Task incomplete, error kind; its workers stopped by the system; their notes shown |
| Worker step | 3, about 2 minutes per step | The worker ends with what it saved and returns incomplete; the coordinator decides once |
| Deep plan, deep report | 2, about 3 minutes | Plan: incomplete before any worker starts. Report: the notes and sources are shown as the result |
| Done check judge | 2, about 1 minute | "Finished, but I couldn't check it"; incomplete, error kind, never done |

## Failures the user hears

- The line the user hears for a failure is fixed English text from code, never a model call at failure time. Nothing resumes, repeats or starts on its own after a stop or an unknown outcome of a paid call or a tool with effects.
- Failure lines use the stuck-or-failed slot of the speech queue; "incomplete, limit hit" may use the done slot. `{task}` is filled from the goal line in core's record, in a short form for long lines. "Here is what I found" is said only when saved findings exist and are shown; otherwise "stopped before it saved any findings". A notice for a task that has recovered is dropped or replaced.
- Every spoken line is also on screen with the cause and the fix. When speech is unavailable, the screen is authoritative.
- **Voice failures never stop the work and need no model**. If the STT socket drops, main reconnects. On key-up main sends the remaining frames and then `ForceEndTurn`. If no final transcript arrives after key release, main closes that utterance id and says "I didn't catch that, say it again."; a late or second final is handled under its own utterance id and never acted on, and nothing acts on a partial transcript. An empty or garbled transcript is "unclear" and goes to the intake check. A hold that runs too long is ended by code as a key-up, and the screen says why.
- If TTS drops mid-line, main keeps the socket alive with Ping and reconnects, and the notice stays unheard. When `text_spoken` is unknown shortly after a key cut, the whole line counts as not heard. If the renderer dies or reloads while the user records or Baymax plays, main closes the utterance id, clears the hold state, drops stale frames and marks the notice unheard.
- **Deepgram down** (key rejected, credits out): nothing can be spoken. Baymax keeps working screen-only with cards, clicks and the stop controls; the hold key shows "voice unavailable" and the screen names the fix.
- **Anthropic down**: the Sonnet retry fails too, and only the no-model path works: the caught "stop" (which still needs STT) and the screen controls (which do not). A late talker or intake reply after a stop or after its utterance was replaced is dropped by request id.

| Failure | Spoken line |
| --- | --- |
| Engine restarting / restart limit reached / not ready in time | "The agents are restarting." / "The agents stopped; see the screen." / "The agents couldn't start; see the screen." |
| Models unreachable | "I can't reach my models right now; use the screen." |
| Anthropic key rejected / no credit / other refusal | "The model service rejected the key; check the screen." / "The model service has no credit left; check the screen." / "The model service refused the call; see the screen." |
| Intake failed / words not caught | "I couldn't start that; say it again." / "I didn't catch that, say it again." |
| "Stop" with nothing running | "Nothing is running." |
| Stop received / proven | "Stopping {task}." or "Stopping everything." / "Stopped {task}; {what still runs}." |
| Incomplete | "{task} stopped at its limit; here is what I found." / "{task} found little on the web; here is what I found." / "{task} hit an error; here is what I found." |
| Report not written | "The notes for {task} are saved, but I couldn't write the report." |
| Done check failed | "{task} is finished, but I couldn't check it; here it is." |
| Storage failure | "I can't save work right now; new work is paused, see the screen." |
| Approval slot: raised again after a restart / late "yes" refused, replacement shown in full | "From before the restart: {the approval line}" / "That request changed; here is the new one." |
| Request outside research | "I can't do that yet in this version." |

Screen only: a Deepgram key failure, worker errors the worker moved past, a worker that ended while its task recovers, progress, "resumed after a restart", "agents starting", a late "yes" refused with no replacement shown, and a sleep notice with no failed task.

## Memory

- Direction, built after cut 1 with its own research: Baymax builds its own memory and asks before it remembers. A proposed memory needs the user's yes and applies from the next task on. Each entry records where and when it came from (the conversation and the date). Cut 1 keeps only session context.
- After cut 1: learning in the background after a task (a helper re-reads the finished conversation and proposes skills, a way of doing a kind of work, and memories, facts about the user; it pauses for a related task and runs again after it). The research plug needs none of it.
- Session recovery (SQLite) is separate from opt-in memory. What is deleted and what may be reused after a "no" is defined when memory is built, after its own research.

## Platform

- Electron 40.2.1 (Node 24.11.1), all TypeScript. Cut 1 is a macOS product.
- Main is Node: hold-key, windows, voice connections, speech queue, talker, keys, engine start / watch / stop. The engine is an Electron `utilityProcess` started with `utilityProcess.fork`. The renderer is the UI, mic capture and playback.
- Hold-key via `uiohook-napi`: Option on macOS, which needs the Accessibility permission. Mic: `NSMicrophoneUsageDescription` and the audio-input entitlement.
- SQLite through Node's built-in `node:sqlite` (synchronous `DatabaseSync`; it prints an "experimental feature" warning), so no npm package, pending its runtime check. The choice between it and a package is asked before the database code is written.

## Starting values

| What | Starting value |
| --- | --- |
| Wait before the talker's quick line | about 3 s |
| Pre-key audio, if the mic stays warm | about 0.3 s |
| Final transcript after key release | about 2 s |
| Longest hold | about 90 s |
| `text_spoken` after a key cut | about 1 s |
| "Stopping" answer from the engine | about 3 s |
| Engine ready after the fork | about 20 s |
| Heartbeat | every about 5 s; after 3 missed beats one probe, answer within about 5 s |
| Engine restart limit | 5 restarts within about 5 minutes |
| Crashes in a row for one task | 3 |
| Refusals in a row before Baymax asks | about 3 |
| "Continue" rounds from the done check | 2 per task |
| Reserve for coordinator, writer and done check | about 40 percent of a deep task's dollar limit |
| Progress combining | at most once per second per agent |
| Web tool live test cap | about 25 Firecrawl credits and $1, model tokens included |

| Depth | Workers | Model calls | Searches | Active time | Dollar limit | Cost target |
| --- | --- | --- | --- | --- | --- | --- |
| Quick | 1 | about 4 to 5 | 2 | 1 minute | about 2 cents | about 1 cent |
| Normal | up to 3 | about 15 | 8 | 5 minutes | about 15 cents | set at build |
| Deep | up to 5 | about 60 | 30 | 20 minutes | about 75 cents | about 50 cents |

## Checks before the engine is built

Run before the code that depends on them; 1 to 4 are small runtime checks on the repo's Electron 40.2.1:
1. `node:sqlite` opens a database inside a `utilityProcess`, and the database lock is released on a crash, a forced kill and refused to a competing engine.
2. How long a stop takes over the main-to-engine message channel.
3. Whether the engine process ends when main is killed.
4. Fork the engine from the packaged app (asar and fuses on) and see its first heartbeat.
5. The Anthropic SDK's own retry and timeout defaults and its error causes for a dropped connection, before the loop is built.
6. Flux TTS access on the team's Deepgram key: one call, run by Aditya, which also shows whether `text_spoken` arrives on an uninterrupted completion; without Flux TTS, TTS starts on Deepgram Aura-2 with the reduced contract ([Speech](#speech)).
7. The folder structure, reviewed once with the `codebase-design` skill.
These checks are one named ticket before the engine ticket.

At build, in the PR that adds the part:
8. Web tool live test, a test script in the web tool's first PR: three questions (a current fact, a niche documentation question, a Reddit discovery question) and four pages (static, JavaScript-only, a short PDF, a blocked or login page), judged on relevant results, usable text, traceable sources, time to the first useful result and a clear error on the blocked page. One cap for the whole test, no automatic retries, PDF pages capped. Aditya picks the tools (Exa vs Tavily, and whether Anthropic's web search and fetch get a place) from the results shown in the PR.
9. Deep report: Opus 5.5 and Fable 5.1 side by side on one report; Fable only if clearly better and inside the cost target.

## Folder map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Main process entry: window, hotkey wiring, IPC |
| `src/preload.ts` | Bridge between main and renderer (`window.baymax`) |
| `src/renderer.ts`, `src/renderer/` | The screen (React): cards, mic capture, playback |
| `src/main/` | Main process: hold-key, windows, voice connections, speech queue, talker, engine start / watch / stop; owns the shown state |
| `src/main/hotkey.ts` | Hold-key detection |
| `src/main/hold.ts` | Hold state from key events; pure |
| `src/main/platform.ts` | Platform flags and labels |
| `src/engine/index.ts` (planned) | Engine entry, started by main; wires in the plugs |
| `src/engine/core/` (planned) | What every plug shares ([Core and plugs](#core-and-plugs)); owns the saved run state |
| `src/engine/plugs/<kind>/` (planned) | One plug each: its tools, prompts and done condition; `plugs/research/` first |
| `src/engine/plugs/index.ts` (planned) | The one list of plugs, as explicit re-exports |
| `src/shared/ipc.ts` | Renderer <-> main channel names and payload types |
| `src/shared/engine.ts` (planned) | Main <-> engine channel names and payload types |
| `src/shared/` third file (planned, named by what it holds, for example `cards.ts`) | Types both links carry: a card, a run state, a pending approval |
| `src/providers/` (planned) | Process-neutral provider code: the Anthropic call with the retry rule, deadlines and the usage record; the Deepgram sockets. Imported by main and the engine; imports nothing from either |

- `src/engine/` imports nothing from `src/main/` (those modules need `BrowserWindow` and `ipcMain`, which a utility process lacks) or `src/renderer/`.
- `src/main/` imports nothing from `src/engine/` except the built bundle path. The renderer never talks to the engine.
- `src/shared/` holds only process-neutral contracts. A link file (`ipc.ts`, `engine.ts`) imports the shared type files; link files never import each other, so the renderer never imports the engine contract, even indirectly.
- The engine core imports no concrete plug; only the engine entry wires in `plugs/index.ts`.
- Main passes the engine, as fork arguments, the database path and the results folder (from `app.getPath("userData")`, which a utility process cannot call), and `execArgv: ["--no-warnings"]` (or a filter) so the `node:sqlite` ExperimentalWarning does not land in the dev log every start.

Config changes in the first build PR (asked first):
- The engine as a second entry of the main webpack bundle (`entry: { index: "./src/index.ts", engine: "./src/engine/index.ts" }` with `output.filename: "[name].js"`, so `.webpack/main/engine.js`; Forge's default `index.js` filename would make the two chunks collide), not a Forge renderer entry. Built-in modules are imported with the `node:` prefix so webpack externalizes them.
- `.eslintrc.json` (today: the `*Sync` rule over all of `src/`, the renderer and main zones, the unused-exports rule, the renderer's no-Node and no-network rules): extend the `import/no-restricted-paths` zones (engine never from main or the renderer; main never from the engine; the renderer never from `src/shared/engine.ts`; `src/providers/` from neither process folder); move the four `*Sync` selectors from the root rule into an override for `src/index.ts`, `src/main/**` and `src/renderer/**` (today the test and config override already drops them), so the engine may use `DatabaseSync`; that synchronous calls stay inside the engine's database module is enforced by review, not by lint; add `src/engine/index.ts` to `ignoreExports`; give `src/engine/**` an override with `env.browser: false`; show each changed rule failing on a bad example.
- `tsconfig.json` `target` to `ES2022` and TypeScript to 5.x: TypeScript 4.5.5 with `target: ES6` cannot compile the `for await` streaming loop the engine needs (checked in a scratchpad `tsc` run); check the SDK's minimum TypeScript, and prove `npm run package` with a one-file `node:sqlite` import before any loop code.
- Dependencies, asked for once at the freeze: `@anthropic-ai/sdk`, the Deepgram client (or raw WebSocket), the search provider client, Firecrawl; `.env.example` gains their key names.
- CI moves from `windows-latest` to `macos-latest`, because cut 1 is a macOS product.

## Set at build

Every starting value above is tuned at build. These are left to build time:
- The exact message shapes between renderer and main and between main and the engine (`src/shared/ipc.ts`, `src/shared/engine.ts`); the coordinator <-> worker message types live inside `src/engine/core/`, not in `src/shared/`.
- Files inside `src/engine/core/` and the other folders beyond this map.
- Prompts, including the intake check's (which pieces of the recent record and screen it sees).
- The length of the short conversation record and how far back "recent" reaches.
- The models not fixed above: the done check judge and the writer for normal research.
- Research result details: counts, tables, card layout, spoken length.
- The plain "stop" rule, tuned by trying it live.
- Whether "send now" becomes "queue" while workers run; the safe points and which tools may be interrupted.
- When the mic opens: on key-down, or warm with the short pre-key audio, by measuring in build week whether the first word is lost; the same voice checks measure false approvals, the key-up frames then `ForceEndTurn`, and the playback reports that feed the session offset for `Interrupt`.
- Whether the talker labels "go on", a progress question and an answer itself, so no intake call is spent on them.
- A short delay before a voice-started task begins, so the user can still say "wait" (starting value: no delay).
- What a reopen keeps and how long after close words still reopen the same task.
- When a done or stopped card leaves the screen; how long the notice list and the step log are kept; the log's page size.
- Each running tool's abort time.
- The 1-hour prompt cache for coordinator and plan calls.
- The fixed spoken lines, tuned by ear once the voice is heard live.
