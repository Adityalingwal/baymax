export const RESTART_DELAY_MS = 2000;
export const EARLY_FAILURE_MS = 10_000;
export const RELAUNCH_MARKER = "--baymax-relaunched";

export type RestartDeps = {
  showNotice: () => void;
  stopWork: () => void;
  relaunch: (args: string[]) => void;
  exit: (code: number) => void;
  setTimer: (ms: number, fire: () => void) => void;
  log: (message: string, error?: unknown) => void;
  now: () => number;
  startedAt: number;
  args: string[]; // the process arguments without the executable
};

export type Restart = (error: unknown, origin: string) => void;

function attempt(deps: RestartDeps, what: string, call: () => void): void {
  try {
    call();
  } catch (error: unknown) {
    deps.log(`${what} failed during restart`, error);
  }
}

function relaunchArgs(args: string[]): string[] {
  return [...args.filter((arg) => arg !== RELAUNCH_MARKER), RELAUNCH_MARKER];
}

// After an uncaught failure Node's state may be undefined, so work stops and the app relaunches once.
export function createRestart(deps: RestartDeps): Restart {
  let pending = false;
  return (error, origin) => {
    if (pending) {
      deps.log(`${origin} while a restart is pending; ignored`, error);
      return;
    }
    pending = true;
    deps.log(`${origin}; restarting`, error);
    const relaunched = deps.args.includes(RELAUNCH_MARKER);
    if (relaunched && deps.now() - deps.startedAt < EARLY_FAILURE_MS) {
      deps.log("failed again soon after a relaunch; restart loop stopped");
      deps.exit(1);
      return;
    }
    attempt(deps, "notice", deps.showNotice);
    attempt(deps, "stopping work", deps.stopWork);
    deps.setTimer(RESTART_DELAY_MS, () => {
      try {
        deps.relaunch(relaunchArgs(deps.args));
      } catch (relaunchError: unknown) {
        deps.log("relaunch failed", relaunchError);
      } finally {
        deps.exit(0);
      }
    });
  };
}
