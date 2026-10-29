import { useEffect, useState, type FormEvent } from "react";
import type { CardActions } from "./actions";

type TextBoxProps = {
  submitQuestion: CardActions["submitQuestion"];
  onDraft: (hasDraft: boolean) => void; // the shell keeps the panel open while the field holds text
  holdKeyLabel: string; // main's label for the hold key, e.g. "⌥"
};

// The glass field: Enter asks; main binds the words to a waiting question or starts a new request.
export function TextBox({
  submitQuestion,
  onDraft,
  holdKeyLabel,
}: TextBoxProps) {
  const [draft, setDraft] = useState("");
  const hasDraft = draft !== "";
  useEffect(() => onDraft(hasDraft), [hasDraft, onDraft]);
  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    submitQuestion({ text });
    setDraft("");
  };
  return (
    <form
      className="glass flex h-10 items-center gap-3 rounded-full pr-4 pl-4"
      onSubmit={ask}
    >
      <input
        aria-label="Ask Baymax"
        placeholder="Ask Baymax…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-[#F5F5F7] placeholder:text-white/50 focus:outline-none"
      />
      {holdKeyLabel !== "" && (
        <span className="type-label shrink-0">{holdKeyLabel} hold to talk</span>
      )}
    </form>
  );
}
