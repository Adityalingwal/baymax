import type { BaymaxApi } from "../shared/ipc";

// What a card or the text box may ask main for; App passes window.baymax or the demo actions.
export type CardActions = Pick<
  BaymaxApi,
  | "submitQuestion"
  | "answerQuestion"
  | "cancelTask"
  | "retryTask"
  | "closeCard"
  | "setCardFolded"
  | "openSource"
  | "setMuted"
>;
