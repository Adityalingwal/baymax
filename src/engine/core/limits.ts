export const taskLimits = {
  modelCalls: 15,
  searches: 8,
  activeMs: 120_000,
  dollars: 0.5,
} as const;

export const roles = {
  intake: { model: "claude-sonnet-5-5", maxTokens: 1024, timeoutMs: 15_000 },
  worker: { model: "claude-sonnet-5-5", maxTokens: 2048, timeoutMs: 60_000 },
  judge: { model: "claude-sonnet-5-5", maxTokens: 1024, timeoutMs: 30_000 },
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
