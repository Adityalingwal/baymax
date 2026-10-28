import type { Findings } from "../../../shared/cards";
import type { EngineEvent } from "../../../shared/engine";
import type { DevLogEntry } from "../../core/dev-log";
import { hostOf } from "./url-host";

function findingsOf(event: EngineEvent): Findings | null {
  if (event.type === "result") return event.findings;
  return event.type === "incomplete" ? event.incomplete.findings : null;
}

// Hostnames only: a URL's path or query can carry the user's words.
// One entry for a terminal event that carries findings: its source ids and their hosts, in sources order.
export function cardSourcesEntry(
  taskId: string,
  event: EngineEvent | null,
): DevLogEntry | null {
  const findings = event === null ? null : findingsOf(event);
  if (findings === null) return null;
  return {
    event: "cardSources",
    taskId,
    sourceIds: findings.sources.map(({ id }) => id).join(","),
    hosts: findings.sources.map(({ url }) => hostOf(url) ?? "").join(","),
  };
}
