export function log(message: string): void {
  console.log(`[Speech] ${message}`);
}

export function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

// An injected callback that throws is logged; it never breaks the speech state.
export function guarded(name: string, call: () => void): boolean {
  try {
    call();
    return true;
  } catch (error) {
    log(`${name} threw: ${describeError(error)}`);
    return false;
  }
}
