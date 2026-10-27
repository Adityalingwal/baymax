import { useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import type { TaskId } from "../../shared/cards";
import type { CardActions } from "../actions";

type AnswerProps = {
  taskId: TaskId;
  markdown: string;
  openSource: CardActions["openSource"];
};

type SourceLinkProps = {
  href: string | undefined;
  children: ReactNode;
  open: (url: string) => void;
};

// No href: main opens the URL only if it is one of the task's read sources.
function SourceLink({ href, children, open }: SourceLinkProps) {
  if (!href) return <span>{children}</span>;
  return (
    <button
      type="button"
      className="cursor-pointer text-sky-300 underline underline-offset-2 hover:text-sky-200"
      onClick={() => open(href)}
    >
      {children}
    </button>
  );
}

export function Answer({ taskId, markdown, openSource }: AnswerProps) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => (
        <SourceLink href={href} open={(url) => openSource({ taskId, url })}>
          {children}
        </SourceLink>
      ),
    }),
    [taskId, openSource],
  );
  return (
    <div className="answer-markdown">
      <Markdown skipHtml disallowedElements={["img"]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
