import type { BaymaxApi } from "../shared/ipc";

// What a card or the text box may ask main for; App passes window.baymax.
export type CardActions = Pick<
  BaymaxApi,
  "submitQuestion" | "cancelTask" | "retryTask" | "openSource" | "setMuted"
>;
