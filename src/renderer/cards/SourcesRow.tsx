import { useState } from "react";
import type { Source, TaskId } from "../../shared/cards";
import type { CardActions } from "../actions";
import { pillButton } from "./CardFrame";
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

function SourceList({ groups, open }: SourceListProps) {
  return (
    <ul className="flex flex-col gap-1">
      {groups.flatMap((group) =>
        group.sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className="flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-2 py-1 text-left hover:bg-zinc-800"
              onClick={() => open(source.url)}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">
                {source.title}
              </span>
              {group.label !== source.title && (
                <span className="shrink-0 text-xs text-zinc-400">
                  {group.label}
                </span>
              )}
            </button>
          </li>
        )),
      )}
    </ul>
  );
}

export function SourcesRow({ taskId, sources, openSource }: SourcesRowProps) {
  const [expanded, setExpanded] = useState(false);
  const groups = sourceGroups(sources);
  const hidden = groups.length - 2;
  const open = (url: string) => openSource({ taskId, url });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {groups.slice(0, 2).map((group) => (
          <button
            key={group.sources[0].id}
            type="button"
            className={pillButton}
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
            className={pillButton}
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
