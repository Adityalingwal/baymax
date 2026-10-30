import { useEffect, useState, type FormEvent } from "react";
import type { CardActions } from "./actions";
import { fieldPlaceholder } from "./panel-contents";

type TextBoxProps = {
  submitQuestion: CardActions["submitQuestion"];
  onDraft: (text: string) => void; // each change, so the shell can restart its auto-close while the field holds text
  holdKeyLabel: string; // main's label for the hold key, e.g. "⌥"
};

// The glass field: Enter asks; main binds the words to a waiting question or starts a new request.
export function TextBox({
  submitQuestion,
  onDraft,
  holdKeyLabel,
}: TextBoxProps) {
  const [draft, setDraft] = useState("");
  useEffect(() => onDraft(draft), [draft, onDraft]);
  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    submitQuestion({ text });
    setDraft("");
  };
  return (
    <form
      className="glass flex h-10 shrink-0 items-center rounded-full pr-4 pl-4"
      onSubmit={ask}
    >
      <input
        aria-label="Ask Baymax"
        placeholder={fieldPlaceholder(holdKeyLabel)}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-[#F5F5F7] placeholder:text-white/50 focus:outline-none"
      />
    </form>
  );
}
