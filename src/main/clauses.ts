// A mark followed by a space, or at the end of the text so far; a "." after a digit there may be the "3." of "3.5".
const sentenceEnd = /[?!](?=\s|$)|\.(?=\s)|(?<!\d)\.$/;

// Cuts text into the whole sentences that can go to speech now, since Aura speaks each flush as its own
// utterance with silence at the join; the rest waits for more text, unless the text ended.
export function takeClauses(
  text: string,
  ended: boolean,
): { clauses: string[]; rest: string } {
  const clauses: string[] = [];
  let rest = text;
  for (
    let mark = sentenceEnd.exec(rest);
    mark !== null;
    mark = sentenceEnd.exec(rest)
  ) {
    const cut = mark.index + 1;
    const clause = rest.slice(0, cut).trim();
    if (clause !== "") clauses.push(clause);
    rest = rest.slice(cut).trimStart();
  }
  if (ended) {
    if (rest.trim() !== "") clauses.push(rest.trim());
    rest = "";
  }
  return { clauses, rest };
}
