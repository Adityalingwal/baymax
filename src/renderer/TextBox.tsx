import { useState, type FormEvent } from "react";
import type { CardActions } from "./actions";

type TextBoxProps = { submitQuestion: CardActions["submitQuestion"] };

export function TextBox({ submitQuestion }: TextBoxProps) {
  const [draft, setDraft] = useState("");
  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "") return;
    submitQuestion({ text });
    setDraft("");
  };
  return (
    <form className="flex gap-2 p-3" onSubmit={ask}>
      <input
        aria-label="Ask Baymax"
        placeholder="Ask Baymax…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-w-0 flex-1 rounded-full bg-[#1C1C1E] px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      />
      <button
        type="submit"
        className="cursor-pointer rounded-full bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
      >
        Ask
      </button>
    </form>
  );
}
