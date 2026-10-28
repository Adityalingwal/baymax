import Markdown from "react-markdown";

type AnswerProps = {
  markdown: string;
};

// A link in the body never navigates: the Sources row below is the only way to open a source.
export function Answer({ markdown }: AnswerProps) {
  return (
    <div className="answer-markdown">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        components={{ a: ({ children }) => <span>{children}</span> }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
