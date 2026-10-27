import { createModelCall } from "../providers/anthropic";
import type { ModelCall } from "../providers/anthropic";
import type { TaskId } from "../shared/cards";
import type {
  EngineCommand,
  EngineEvent,
  EnginePort,
  EngineStartOptions,
} from "../shared/engine";
import { guardLog, messageOf, writeDevLog } from "./core/dev-log";
import type { DevLog } from "./core/dev-log";
import type { DispatchDeps } from "./core/dispatch";
import { runIntake } from "./core/intake";
import type { IntakeResult } from "./core/intake";
import type { IntakeCommand } from "./core/intake-prompt";
import { createTaskBudget } from "./core/limits";
import { createPort } from "./core/port";
import type { PortSide } from "./core/port";

export type EngineFakes = {
  model?: ModelCall; // replaces the real Anthropic call (src/providers/anthropic.ts)
  now?: () => number; // milliseconds; replaces performance.now
  log?: DevLog; // replaces the dev log
};

type Hold = { controller: AbortController; settled: Promise<void> };

type Engine = {
  deps: DispatchDeps;
  holds: Map<TaskId, Hold>;
  side: PortSide;
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

// Catches everything, so the hold's settled promise never rejects.
async function runCommand(
  engine: Engine,
  command: IntakeCommand,
  controller: AbortController,
): Promise<void> {
  const { taskId } = command;
  let event: EngineEvent | null;
  try {
    const budget = createTaskBudget();
    const job = {
      taskId,
      role: "intake" as const,
      budget,
      signal: controller.signal,
    };
    event = eventFor(taskId, await runIntake(engine.deps, job, command));
  } catch (error) {
    engine.deps.log({
      event: "commandError",
      taskId,
      message: messageOf(error),
    });
    event = { type: "failure", taskId, kind: "error" };
  }
  engine.holds.delete(taskId);
  if (event !== null && !controller.signal.aborted) engine.side.emit(event);
}

function startIntake(engine: Engine, command: IntakeCommand): void {
  if (engine.holds.has(command.taskId)) {
    engine.deps.log({ event: "duplicateTask", taskId: command.taskId });
    return;
  }
  const controller = new AbortController();
  const hold: Hold = { controller, settled: Promise.resolve() };
  engine.holds.set(command.taskId, hold);
  hold.settled = runCommand(engine, command, controller);
}

function cancelTask(engine: Engine, taskId: TaskId): void {
  const cancelled: EngineEvent = { type: "cancelled", taskId, findings: null };
  const held = engine.holds.get(taskId);
  if (held === undefined) {
    engine.side.emitLater(cancelled);
    return;
  }
  held.controller.abort();
  held.settled.then(
    () => engine.side.emit(cancelled),
    () => undefined,
  );
}

function receive(engine: Engine, command: EngineCommand): void {
  switch (command.type) {
    case "question":
    case "clarifyingAnswer":
      startIntake(engine, command);
      return;
    case "cancel":
      cancelTask(engine, command.taskId);
      return;
    case "runTask":
      engine.side.emitLater({
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
  const holds = new Map<TaskId, Hold>();
  const side = createPort({
    log,
    // receive runs only on a later send, after engine below exists.
    receive: (command) => receive(engine, command),
    close: () => {
      for (const hold of holds.values()) hold.controller.abort();
      holds.clear();
    },
  });
  const engine: Engine = { deps, holds, side };
  return side.port;
}
