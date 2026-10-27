import { createModelCall } from "../providers/anthropic";
import type { ModelCall } from "../providers/anthropic";
import type { TaskId } from "../shared/cards";
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
import type { Holds } from "./core/holds";
import { runIntake } from "./core/intake";
import type { IntakeResult } from "./core/intake";
import type { IntakeCommand } from "./core/intake-prompt";
import { createTaskBudget } from "./core/limits";
import { createPort } from "./core/port";

export type EngineFakes = {
  model?: ModelCall; // replaces the real Anthropic call (src/providers/anthropic.ts)
  now?: () => number; // milliseconds; replaces performance.now
  log?: DevLog; // replaces the dev log
};

type Engine = { deps: DispatchDeps; holds: Holds };

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
    onThrow: { type: "failure", taskId, kind: "error" },
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
      engine.holds.side.emitLater({
        type: "incomplete",
        taskId: command.taskId,
        incomplete: { kind: "error", cause: "error", findings: null },
      });
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
  const engine: Engine = { deps, holds: createHolds(log, side) };
  return side.port;
}
