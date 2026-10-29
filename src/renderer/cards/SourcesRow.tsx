import { useState } from "react";
import type { Source, TaskId } from "../../shared/cards";
import type { CardActions } from "../actions";
import { sourceGroups, type SourceGroup } from "./forms";

type SourcesRowProps = {
  taskId: TaskId;
  sources: Source[];
  openSource: CardActions["openSource"];
};

type SourceListProps = {
  groups: SourceGroup[];
  open: (url: string) => void;
};

const sourceLink =
  "type-label cursor-pointer underline underline-offset-2 hover:text-white";

function SourceList({ groups, open }: SourceListProps) {
  return (
    <ul className="flex flex-col gap-1">
      {groups.flatMap((group) =>
        group.sources.map((source) => (
          <li key={source.id} className="flex min-w-0 items-baseline gap-2">
            <button
              type="button"
              className={`${sourceLink} min-w-0 truncate text-left`}
              onClick={() => open(source.url)}
            >
              {source.title}
            </button>
            {group.label !== source.title && (
              <span className="type-hint shrink-0">{group.label}</span>
            )}
          </li>
        )),
      )}
    </ul>
  );
}

// The sources under an answer, underlined; the only way to open one, through main.
export function SourcesRow({ taskId, sources, openSource }: SourcesRowProps) {
  const [expanded, setExpanded] = useState(false);
  const groups = sourceGroups(sources);
  const hidden = groups.length - 2;
  const open = (url: string) => openSource({ taskId, url });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {groups.slice(0, 2).map((group) => (
          <button
            key={group.sources[0].id}
            type="button"
            className={sourceLink}
            onClick={() => open(group.sources[0].url)}
          >
            {group.label}
          </button>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${hidden} more sources`}
            className={sourceLink}
            onClick={() => setExpanded((value) => !value)}
          >
            +{hidden}
          </button>
        )}
      </div>
      {expanded && <SourceList groups={groups} open={open} />}
    </div>
  );
}
