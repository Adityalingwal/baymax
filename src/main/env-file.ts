import { parseEnv } from "node:util";

export type EnvFileDeps = {
  path: string;
  readFile: (path: string) => Promise<string>;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
};

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "unknown";
}

// A name already in the environment keeps its value, as with Node's own env-file loading: the shell wins.
export async function loadEnvFile(deps: EnvFileDeps): Promise<void> {
  let content: string;
  try {
    content = await deps.readFile(deps.path);
  } catch (error: unknown) {
    const code = errorCode(error);
    deps.log(
      code === "ENOENT"
        ? `No env file at ${deps.path}; using the environment only`
        : `Env file not read (${code}); using the environment only`,
    );
    return;
  }
  for (const [name, value] of Object.entries(parseEnv(content))) {
    if (value !== undefined && deps.env[name] === undefined) {
      deps.env[name] = value;
    }
  }
}
