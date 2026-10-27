import { describe, expect, it } from "vitest";
import { loadEnvFile } from "./env-file";

const path = "/app/.env";
const fileText = [
  "ANTHROPIC_API_KEY=ant-secret",
  "EXA_API_KEY=exa-secret",
  "# a comment",
  "SHELL_SET=file-value",
].join("\n");

function failure(code: string): Error {
  return Object.assign(new Error(`${code}: read failed`), { code });
}

type Row = {
  name: string;
  read: () => Promise<string>;
  env: Record<string, string | undefined>;
  expectedEnv: Record<string, string | undefined>;
  expectedLogs: string[];
};

const rows: Row[] = [
  {
    name: "a missing file leaves the env unchanged and logs one line",
    read: () => Promise.reject(failure("ENOENT")),
    env: { PATH: "/usr/bin" },
    expectedEnv: { PATH: "/usr/bin" },
    expectedLogs: [`No env file at ${path}; using the environment only`],
  },
  {
    name: "parsed names are merged",
    read: () => Promise.resolve(fileText),
    env: {},
    expectedEnv: {
      ANTHROPIC_API_KEY: "ant-secret",
      EXA_API_KEY: "exa-secret",
      SHELL_SET: "file-value",
    },
    expectedLogs: [],
  },
  {
    name: "a name already in the env keeps its value",
    read: () => Promise.resolve(fileText),
    env: { SHELL_SET: "shell-value", EXA_API_KEY: "" },
    expectedEnv: {
      ANTHROPIC_API_KEY: "ant-secret",
      EXA_API_KEY: "",
      SHELL_SET: "shell-value",
    },
    expectedLogs: [],
  },
  {
    name: "another read error leaves the env unchanged and logs its code",
    read: () => Promise.reject(failure("EACCES")),
    env: { PATH: "/usr/bin" },
    expectedEnv: { PATH: "/usr/bin" },
    expectedLogs: ["Env file not read (EACCES); using the environment only"],
  },
];

describe("loadEnvFile", () => {
  it.each(rows)("$name", async ({ read, env, expectedEnv, expectedLogs }) => {
    const logs: string[] = [];
    const paths: string[] = [];
    await loadEnvFile({
      path,
      readFile: (file) => {
        paths.push(file);
        return read();
      },
      env,
      log: (message) => logs.push(message),
    });
    expect(paths).toEqual([path]);
    expect(env).toEqual(expectedEnv);
    expect(logs).toEqual(expectedLogs);
  });

  it("never logs a value from the file", async () => {
    const logs: string[] = [];
    const readers = [
      () => Promise.resolve(fileText),
      () => Promise.reject(failure("EACCES")),
      () => Promise.reject(new Error("ant-secret exa-secret")),
    ];
    for (const read of readers) {
      await loadEnvFile({
        path,
        readFile: read,
        env: {},
        log: (message) => logs.push(message),
      });
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toMatch(/ant-secret|exa-secret|file-value/);
    }
  });
});
