// The brief writer's four parts plus the user's exact words, since a restated goal can lose a nuance.
export type WorkerBrief = {
  goal: string;
  resultShape: string;
  sources: string;
  limits: string;
  userWords: string;
};
