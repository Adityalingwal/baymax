// About this many characters without punctuation make a clause, cut at the last space.
const clauseChars = 40;

// Cuts text into the clauses that can go to speech now: up to a punctuation mark followed by a space
// within about 40 characters, else about 40 characters; the rest waits for more text, unless the text ended.
export function takeClauses(
  text: string,
  ended: boolean,
): { clauses: string[]; rest: string } {
  const clauses: string[] = [];
  let rest = text;
  for (;;) {
    const mark = /[.,;:!?]\s/.exec(rest);
    const markCut = mark === null ? -1 : mark.index + 1;
    let cut = markCut !== -1 && markCut <= clauseChars ? markCut : -1;
    if (cut === -1 && rest.length >= clauseChars) {
      const space = rest.lastIndexOf(" ", clauseChars);
      cut = space > 0 ? space : clauseChars;
    }
    if (cut === -1) break;
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
