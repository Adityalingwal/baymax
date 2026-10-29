export const taskLimits = {
  modelCalls: 30,
  searches: 20,
  activeMs: 240_000,
  dollars: 0.5,
} as const;

export const roles = {
  briefWriter: {
    model: "claude-sonnet-5-5",
    maxTokens: 1024,
    timeoutMs: 20_000,
  },
  briefRetry: { model: "claude-opus-5-5", maxTokens: 2048, timeoutMs: 20_000 }, // Opus always thinks, and thinking counts against max_tokens
  worker: { model: "claude-sonnet-5-5", maxTokens: 2048, timeoutMs: 60_000 },
} as const;

export type Role = keyof typeof roles;

export type RoleModel = (typeof roles)[Role]["model"];

// What this task has used so far.
export type TaskBudget = {
  modelCalls: number;
  activeMs: number;
  dollars: number;
};

export function createTaskBudget(): TaskBudget {
  return { modelCalls: 0, activeMs: 0, dollars: 0 };
}
