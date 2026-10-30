import type { Aura } from "../providers/aura";
import { takeClauses } from "./clauses";

// A line's text as it is written; changed: speech is told when more arrives.
export type LineText = {
  text: string;
  ended: boolean;
  changed: (() => void) | null;
};

// A line on the Aura socket while its text and audio still flow; seq numbers its chunks.
export type StreamJob = {
  seq: number;
  taken: number; // characters of the line's text already cut into clauses
  flushesSent: number;
  flushesDone: number;
  textEnded: boolean;
};

export function newStreamJob(): StreamJob {
  return { seq: 0, taken: 0, flushesSent: 0, flushesDone: 0, textEnded: false };
}

// Every send is checked; false means the socket failed and the line takes the socket-failure path.
function sendClauses(
  aura: Aura,
  stream: StreamJob,
  clauses: string[],
): boolean {
  for (const clause of clauses) {
    if (!aura.speak(clause)) return false;
    stream.flushesSent += 1;
    if (!aura.flush()) return false;
  }
  return true;
}

// Text goes out sentence by sentence as it arrives, with a Flush each time.
export function sendText(
  aura: Aura,
  stream: StreamJob,
  feed: LineText,
): boolean {
  const { text, ended } = feed;
  const { clauses, rest } = takeClauses(text.slice(stream.taken), ended);
  stream.taken = text.length - rest.length;
  if (!sendClauses(aura, stream, clauses)) return false;
  if (!ended) return true;
  stream.textEnded = true;
  feed.changed = null;
  return true;
}
