import type { FailureCause } from "../../src/shared/engine";
import { ipcChannels } from "../../src/shared/ipc";
import { decision, findings, replyRoute } from "./tasks/harness";
import { admitAs, streamFront } from "./wiring.harness";
import type { Wired } from "./wiring.harness";

export const ask = (w: Wired, text: string) =>
  w.send(ipcChannels.submitQuestion, { text });

export const retryRoute = (taskId: string) =>
  decision({ route: "retry", taskId });

export const failTask = (
  w: Wired,
  taskId = "t1",
  cause: FailureCause = "error",
) =>
  w.port.emit({
    type: "failed",
    taskId,
    cause,
    reason: null,
    findings: findings("- Page one"),
  });

export const offerLine =
  "The hermes check hit an error. Shall I try once more?";

export const newResult = {
  type: "result",
  taskId: "t1",
  spokenLine: "Hermes runs a loop.",
  findings: findings("Hermes runs a loop."),
} as const;

export const turnOf = (w: Wired, index: number) =>
  String(w.talkerCalls[index].request.messages.at(-1)?.content);

export const lastTurn = (w: Wired) => turnOf(w, w.talkerCalls.length - 1);

// The turns before the current one, as the last talker call read them.
export function historyOf(w: Wired): string[] {
  const messages = w.talkerCalls.at(-1)?.request.messages ?? [];
  return messages
    .slice(0, -1)
    .map(({ content }) =>
      typeof content === "string"
        ? content
        : content.map((block) => ("text" in block ? block.text : "")).join(""),
    );
}

// A running task that failed and whose failure turn was told, with everything played out.
export async function failedTask(w: Wired): Promise<void> {
  await admitAs(w, "hermes");
  await w.playAll();
  failTask(w);
  await streamFront(w, replyRoute(), offerLine);
  await w.playAll();
}
