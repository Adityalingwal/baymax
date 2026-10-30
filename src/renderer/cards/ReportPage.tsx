import type { TaskCard } from "../../shared/cards";
import type { CardActions } from "../actions";
import { Answer } from "./Answer";
import { Chevron } from "./Chevron";
import { cardTitle } from "./forms";
import { SourcesRow } from "./SourcesRow";

type ReportBodyProps = {
  card: TaskCard;
  report: string;
  openSource: CardActions["openSource"];
};

// The full report and its sources, on the report page and in the island. No height of its own; only a wide line scrolls sideways here.
export function ReportBody({ card, report, openSource }: ReportBodyProps) {
  const sources = card.answer?.sources ?? [];
  return (
    <>
      <div className="overflow-x-auto overflow-y-hidden break-words">
        <Answer markdown={report} />
      </div>
      {sources.length > 0 && (
        <SourcesRow
          taskId={card.taskId}
          sources={sources}
          openSource={openSource}
        />
      )}
    </>
  );
}

type ReportPageProps = ReportBodyProps & { onBack: () => void };

// Replaces the Tasks list. Back stays in place while the report scrolls under it.
export function ReportPage({ onBack, ...body }: ReportPageProps) {
  return (
    <section className="flex min-h-0 shrink flex-col gap-3">
      <button type="button" className="report-back" onClick={onBack}>
        <Chevron direction="left" />
        Back
      </button>
      <div className="min-h-0 overflow-y-auto">
        <article className="glass flex flex-col gap-2.5 rounded-[20px] px-4 py-3.5">
          <h3 className="type-title">{cardTitle(body.card)}</h3>
          <ReportBody {...body} />
        </article>
      </div>
    </section>
  );
}
