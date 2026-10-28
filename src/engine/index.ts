import { createModelCall } from "../providers/anthropic";
import type { ModelCall } from "../providers/anthropic";
import { readPageContents } from "../providers/page-contents";
import type { ContentsFn } from "../providers/page-contents";
import { searchWeb } from "../providers/search";
import type { SearchFn } from "../providers/search";
import type { Findings, TaskId } from "../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  EnginePort,
  EngineStartOptions,
} from "../shared/engine";
import { guardLog, writeDevLog } from "./core/dev-log";
import type { DevLog } from "./core/dev-log";
import type { DispatchDeps } from "./core/dispatch";
import { cancelHold, closeHolds, createHolds, startHold } from "./core/holds";
import type { FoundSoFar, Holds } from "./core/holds";
import { runIntake } from "./core/intake";
import type { IntakeResult } from "./core/intake";
import type { IntakeCommand } from "./core/intake-prompt";
import { createTaskBudget } from "./core/limits";
import { createPort } from "./core/port";
import { runResearch } from "./plugs";
import type { RunTaskCommand, WebAccess } from "./plugs";

export type EngineFakes = {
  model?: ModelCall; // replaces the real Anthropic call (src/providers/anthropic.ts)
  now?: () => number; // milliseconds; replaces performance.now
  log?: DevLog; // replaces the dev log
  search?: SearchFn; // replaces the real search call (src/providers/search.ts)
  contents?: ContentsFn; // replaces the real page-contents call (src/providers/page-contents.ts)
  lookup?: WebAccess["lookup"]; // replaces DNS for page reads
  connect?: WebAccess["connect"]; // replaces sockets for page reads
  today?: () => string; // ISO date, such as 2026-10-27
};

type Engine = {
  deps: DispatchDeps;
  holds: Holds;
  access: WebAccess;
  today: () => string;
};

function eventFor(taskId: TaskId, result: IntakeResult): EngineEvent | null {
  if (result.kind === "intake") {
    return { type: "intake", taskId, outcome: result.outcome };
  }
  if (result.kind === "failure") {
    return { type: "failure", taskId, kind: result.failure };
  }
  return null;
}

function startIntake(engine: Engine, command: IntakeCommand): void {
  const { taskId } = command;
  startHold(engine.holds, taskId, {
    start: async (signal) => {
      const budget = createTaskBudget();
      const job = { taskId, role: "intake" as const, budget, signal };
      return eventFor(taskId, await runIntake(engine.deps, job, command));
    },
    found: () => null,
    onThrow: () => ({ type: "failure", taskId, kind: "error" }),
  });
}

function endOf(event: EngineEvent | null): string {
  if (event === null) return "cancelled";
  if (event.type !== "incomplete") return event.type;
  const { incomplete } = event;
  return incomplete.kind === "error"
    ? `error:${incomplete.cause}`
    : incomplete.kind;
}

// One fresh budget per run, shared by the worker and the judge; the hold sends the one terminal event.
// The run keeps found current from its start, so a cancel or a throw still carries what it found.
function startRun(engine: Engine, command: RunTaskCommand): void {
  const { taskId } = command;
  const { deps, holds } = engine;
  const found: FoundSoFar = { current: () => null };
  const run = (signal: AbortSignal) =>
    runResearch({
      deps,
      task: { taskId, budget: createTaskBudget(), signal },
      command,
      access: engine.access,
      today: engine.today(),
      found,
      progress: (event) => {
        if (!signal.aborted) holds.side.emit(event);
      },
    });
  startHold(holds, taskId, {
    start: async (signal) => {
      let how = "thrown";
      try {
        const event = await run(signal);
        how = endOf(signal.aborted ? null : event);
        return event;
      } finally {
        deps.log({ event: "taskEnd", taskId, how });
      }
    },
    found: () => found.current(),
    onThrow: (findings: Findings | null) => ({
      type: "incomplete",
      taskId,
      incomplete: { kind: "error", cause: "error", findings },
    }),
  });
}

function receive(engine: Engine, command: EngineCommand): void {
  switch (command.type) {
    case "question":
    case "clarifyingAnswer":
      startIntake(engine, command);
      return;
    case "cancel":
      cancelHold(engine.holds, command.taskId);
      return;
    case "runTask":
      startRun(engine, command);
      return;
    default: {
      const unknownCommand: never = command;
      engine.deps.log({ event: "unknownCommand", taskId: null });
      return unknownCommand;
    }
  }
}

export function startEngine(
  options: EngineStartOptions,
  fakes: EngineFakes = {},
): EnginePort {
  const log = guardLog(fakes.log ?? writeDevLog);
  const call = fakes.model ?? createModelCall({ apiKey: options.anthropicKey });
  const deps: DispatchDeps = {
    call,
    now: fakes.now ?? (() => performance.now()),
    log,
  };
  const side = createPort({
    log,
    // receive and close run only on a later call, after engine below exists.
    receive: (command) => receive(engine, command),
    close: () => closeHolds(engine.holds),
  });
  const search: SearchFn =
    fakes.search ??
    ((query, signal) =>
      searchWeb({ query, key: options.searchKey, fetch, signal }));
  // Exa is the one search provider, so its key also reads page contents.
  const contents: ContentsFn =
    fakes.contents ??
    ((url, signal) =>
      readPageContents({ url, key: options.searchKey, fetch, signal }));
  const engine: Engine = {
    deps,
    holds: createHolds(log, side),
    access: { search, contents, lookup: fakes.lookup, connect: fakes.connect },
    today: fakes.today ?? (() => new Date().toISOString().slice(0, 10)),
  };
  return side.port;
}
